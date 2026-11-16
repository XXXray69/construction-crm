import { createClient } from '@supabase/supabase-js';
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const configured = Boolean(url && key);
export const supabase = createClient(url || 'https://example.supabase.co', key || 'placeholder');
export type Profile = {id:string;full_name:string;role:'manager'|'worker'};
export type Project = {id:string;name:string;address:string;created_at:string};
export type Status = 'new'|'in_progress'|'review'|'accepted'|'revision';
export type Task = {id:string;project_id:string;title:string;description:string;assignee_id:string;created_by:string;status:Status;created_at:string};
export type History = {id:number;task_id:string;actor_id:string;from_status:Status;to_status:Status;comment:string|null;changed_at:string};
export const statusName:Record<Status,string> = {new:'Новая',in_progress:'В работе',review:'На проверке',accepted:'Принята',revision:'На доработке'};
export const statusColor:Record<Status,string> = {new:'default',in_progress:'processing',review:'warning',accepted:'success',revision:'error'};
export const actions:Record<Status,{to:Status;label:string;role:'manager'|'worker'}[]> = {
  new:[{to:'in_progress',label:'Взять в работу',role:'worker'}],
  in_progress:[{to:'review',label:'Отправить на проверку',role:'worker'}],
  review:[{to:'accepted',label:'Принять задачу',role:'manager'},{to:'revision',label:'Вернуть на доработку',role:'manager'}],
  revision:[{to:'in_progress',label:'Возобновить работу',role:'worker'}],
  accepted:[]
};
