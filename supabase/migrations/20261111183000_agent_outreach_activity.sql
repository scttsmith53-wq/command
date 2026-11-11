create table public.agent_outreach_activity (
  request_id uuid primary key,
  queue_id bigint not null references public.agent_call_queue(id),
  kind text not null check (kind in ('call','phone_text','ghl_text')),
  state text not null check (state in ('recorded','pending','accepted','failed','unknown')),
  occurred_at timestamptz not null default now(),
  is_first boolean not null,
  provider_message_id text
);
alter table public.agent_outreach_activity enable row level security;
revoke all on public.agent_outreach_activity from anon, authenticated;
create index agent_outreach_activity_date_idx on public.agent_outreach_activity (occurred_at);
create index agent_outreach_activity_contact_idx on public.agent_outreach_activity (queue_id, kind, state);

create function public.agent_outreach_record(p_id bigint,p_request uuid,p_kind text)
returns jsonb language plpgsql set search_path = public as $$
declare
  agent agent_call_queue%rowtype;
  activity agent_outreach_activity%rowtype;
  initial_state text;
  first_contact boolean;
begin
  select * into strict agent from agent_call_queue where id=p_id for update;
  select * into activity from agent_outreach_activity where request_id=p_request;
  if found then
    if activity.queue_id <> p_id or activity.kind <> p_kind then
      raise exception 'Activity request ID already used';
    end if;
    return jsonb_build_object('created',false,'state',activity.state);
  end if;
  if p_kind <> 'call' and exists (
    select 1 from agent_outreach_activity where queue_id=p_id
      and kind='ghl_text' and state='pending'
      and occurred_at > now() - interval '2 minutes'
  ) then
    raise exception 'Text send still pending';
  end if;
  initial_state := case when p_kind='ghl_text' then 'pending' else 'recorded' end;
  first_contact := case when p_kind='call' then coalesce(agent.calls,0)=0
    else not coalesce(agent.texted,false) and not exists (
      select 1 from agent_outreach_activity where queue_id=p_id and kind <> 'call'
        and state in ('accepted','recorded')
    ) end;
  insert into agent_outreach_activity(request_id,queue_id,kind,state,is_first)
    values(p_request,p_id,p_kind,initial_state,first_contact);
  if p_kind='call' then
    update agent_call_queue set calls=coalesce(calls,0)+1,last_called=now() where id=p_id;
  elsif p_kind='phone_text' then
    update agent_call_queue set texted=true where id=p_id;
  end if;
  return jsonb_build_object('created',true,'state',initial_state);
end $$;

create function public.agent_outreach_finish(p_request uuid,p_state text,p_message_id text)
returns void language plpgsql set search_path = public as $$
begin
  if p_state not in ('accepted','failed','unknown') then raise exception 'Invalid SMS state'; end if;
  perform 1 from agent_call_queue q join agent_outreach_activity a on a.queue_id=q.id
  where a.request_id=p_request for update of q;
  update agent_outreach_activity set state=p_state,provider_message_id=p_message_id
  where request_id=p_request and kind='ghl_text' and state='pending';
  if found and p_state='accepted' then
    update agent_call_queue set texted=true where id=(
      select queue_id from agent_outreach_activity where request_id=p_request
    );
  end if;
end $$;

create function public.agent_outreach_report(p_from date,p_to date)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'calls', count(*) filter(where kind='call'),
    'unique_called',count(distinct queue_id) filter(where kind='call'),
    'first_calls',count(*) filter(where kind='call' and is_first),
    'recalls',count(*) filter(where kind='call' and not is_first),
    'texts',count(*) filter(where (kind='phone_text' and state='recorded') or (kind='ghl_text' and state='accepted')),
    'unique_texted',count(distinct queue_id) filter(where kind <> 'call' and state in ('accepted','recorded')),
    'first_texts',count(*) filter(where kind <> 'call' and state in ('accepted','recorded') and is_first),
    'repeat_texts',count(*) filter(where kind <> 'call' and state in ('accepted','recorded') and not is_first),
    'phone_texts',count(*) filter(where kind='phone_text'),
    'ghl_texts',count(*) filter(where kind='ghl_text' and state='accepted'),
    'unconfirmed_texts',count(*) filter(where kind='ghl_text' and state in ('pending','unknown')),
    'failed_texts',count(*) filter(where kind='ghl_text' and state='failed')
  )
  from agent_outreach_activity
  where occurred_at >= (p_from::timestamp at time zone 'America/Denver')
    and occurred_at < ((p_to + 1)::timestamp at time zone 'America/Denver')
$$;
revoke all on function public.agent_outreach_record(bigint,uuid,text), public.agent_outreach_finish(uuid,text,text), public.agent_outreach_report(date,date) from public, anon, authenticated;
grant execute on function public.agent_outreach_record(bigint,uuid,text), public.agent_outreach_finish(uuid,text,text), public.agent_outreach_report(date,date) to service_role;

CREATE OR REPLACE FUNCTION public.agent_outreach_mark(p_id bigint, p_action text, p_notes text)
 RETURNS void
 LANGUAGE plpgsql SET search_path = public
AS $function$
declare queue_action text := p_action;
begin
  update agent_call_queue set
    texted = case when queue_action = 'worked' then true
                  when queue_action = 'untext' then false
                  else texted end,
    status = case queue_action
               when 'worked'    then 'worked'
               when 'finish'    then 'worked'
               when 'skip'      then 'skip'
               when 'dnc'       then 'skip'
               when 'talked'    then 'active'
               when 'follow_up' then 'active'
               else status
             end,
    callback_on = case when queue_action in ('talked','follow_up','no_answer','skip','dnc')
                       then null else callback_on end,
    text_follow_up_on = case when queue_action in ('skip','dnc') or (queue_action = 'worked' and text_follow_up_on <= (now() at time zone 'America/Denver')::date)
                             then null else text_follow_up_on end,
    text_follow_up_message = case when queue_action in ('skip','dnc') or (queue_action = 'worked' and text_follow_up_on <= (now() at time zone 'America/Denver')::date)
                                  then null else text_follow_up_message end,
    notes = case
              when coalesce(nullif(trim(p_notes),''), '') = '' then notes
              when coalesce(nullif(trim(notes),''), '') = ''
                then to_char(now() at time zone 'America/Denver','MM/DD/YY') || ': ' || trim(p_notes)
              else notes || E'\n' || to_char(now() at time zone 'America/Denver','MM/DD/YY') || ': ' || trim(p_notes)
            end
  where id = p_id;
end;
$function$
;
revoke all on function public.agent_outreach_mark(bigint,text,text) from public, anon, authenticated;
grant execute on function public.agent_outreach_mark(bigint,text,text) to service_role;
