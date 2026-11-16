import { useCallback, useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Card, ConfigProvider, Descriptions, Empty, Form, Input, Layout, List, Menu, Modal, Select, Space, Spin, Statistic, Tag, Timeline, Typography } from 'antd';
import { ApartmentOutlined, CheckSquareOutlined, LogoutOutlined, PlusOutlined, ReloadOutlined, SafetyOutlined } from '@ant-design/icons';
import type { Session } from '@supabase/supabase-js';
import { supabase, configured, actions, statusColor, statusName } from './db';
import type { Profile, Project, Task, History, Status } from './db';

const {Header, Sider, Content} = Layout;
const {Title, Text, Paragraph} = Typography;
function prettyDate(value:string) { return new Date(value).toLocaleString('ru-RU'); }
function StatusTag({value}:{value:Status}) {return <Tag color={statusColor[value]}>{statusName[value]}</Tag>}

function CRM() {
  const {message, modal} = AntApp.useApp();
  const [session,setSession] = useState<Session|null>(null);
  const [authReady,setAuthReady] = useState(false);
  const [profile,setProfile] = useState<Profile|null>(null);
  const [workers,setWorkers] = useState<Profile[]>([]);
  const [projects,setProjects] = useState<Project[]>([]);
  const [tasks,setTasks] = useState<Task[]>([]);
  const [history,setHistory] = useState<History[]>([]);
  const [active,setActive] = useState<'projects'|'mine'>('projects');
  const [projectId,setProjectId] = useState<string|null>(null);
  const [taskId,setTaskId] = useState<string|null>(null);
  const [dialog,setDialog] = useState<'project'|'task'|null>(null);
  const [editingId,setEditingId] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(false);
  const [form] = Form.useForm();
  const manager = profile?.role === 'manager';
  const selectedProject = projects.find(p=>p.id===projectId);
  const selectedTask = tasks.find(t=>t.id===taskId);
  const currentWorker = (id:string) => workers.find(w=>w.id===id)?.full_name || (id===profile?.id ? profile.full_name : 'Исполнитель');

  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>{setSession(data.session);setAuthReady(true);});
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,s)=>{setSession(s);if(!s){setProfile(null);setProjects([]);setTasks([]);}});
    return ()=>subscription.unsubscribe();
  },[]);

  const reload=useCallback(async()=>{
    if(!session?.user) return;
    setLoading(true);
    const [me,p,t,w]=await Promise.all([
      supabase.from('profiles').select('*').eq('id',session.user.id).single(),
      supabase.from('projects').select('*').order('created_at',{ascending:false}),
      supabase.from('tasks').select('*').order('created_at',{ascending:false}),
      supabase.from('profiles').select('*').eq('role','worker')
    ]);
    if(me.error)message.error('Не найден профиль. Создай запись в public.profiles в Supabase.');
    if(p.error)message.error(p.error.message);
    if(t.error)message.error(t.error.message);
    setProfile(me.data as Profile|null);
    setProjects((p.data||[]) as Project[]);
    setTasks((t.data||[]) as Task[]);
    setWorkers((w.data||[]) as Profile[]);
    setLoading(false);
  },[session?.user,message]);
  useEffect(()=>{void reload();},[reload]);
  useEffect(()=>{if(!taskId){setHistory([]);return;}supabase.from('task_history').select('*').eq('task_id',taskId).order('changed_at',{ascending:false}).then(({data,error})=>{if(error)message.error(error.message);setHistory((data||[]) as History[]);});},[taskId,message,tasks]);

  const run=async(action:()=>PromiseLike<{error:{message:string}|null}>, success:string)=>{
    setBusy(true);
    try{const result=await action();if(result.error)throw new Error(result.error.message);message.success(success);setDialog(null);setEditingId(null);await reload();}
    catch(e){message.error(e instanceof Error?e.message:'Ошибка операции');}
    finally{setBusy(false);}
  };
  const openProject=(p?:Project)=>{setEditingId(p?.id||null);form.setFieldsValue({name:p?.name||'',address:p?.address||''});setDialog('project');};
  const openTask=(t?:Task)=>{setEditingId(t?.id||null);form.setFieldsValue({title:t?.title||'',description:t?.description||'',project_id:t?.project_id||projectId||undefined,assignee_id:t?.assignee_id||undefined});setDialog('task');};
  const submitForm=async(values:Record<string,string>)=>{
    if(dialog==='project') await run(()=> editingId?supabase.from('projects').update(values).eq('id',editingId):supabase.from('projects').insert(values),'Объект сохранён');
    if(dialog==='task') await run(()=> editingId?supabase.from('tasks').update(values).eq('id',editingId):supabase.from('tasks').insert({...values,created_by:session!.user.id,status:'new'}),'Задача сохранена');
  };
  const remove=(kind:'project'|'task',id:string)=>modal.confirm({title:kind==='project'?'Удалить объект и все его задачи?':'Удалить задачу?',content:'Это действие нельзя отменить.',okText:'Удалить',cancelText:'Отмена',okType:'danger',onOk:async()=>{
    await run(()=>supabase.from(kind==='project'?'projects':'tasks').delete().eq('id',id),'Удалено');
    if(kind==='project'){setProjectId(null);setTaskId(null);}else setTaskId(null);
  }});
  const changeStatus=(to:Status)=>{
    if(!selectedTask)return;
    if(to==='revision'){
      let comment='';
      modal.confirm({title:'Вернуть задачу на доработку',content:<Input.TextArea placeholder="Укажите причину возврата" rows={4} onChange={e=>{comment=e.target.value;}}/>,okText:'Вернуть',cancelText:'Отмена',onOk:async()=>{
        if(!comment.trim()){message.error('Укажите комментарий');return Promise.reject(new Error('Комментарий обязателен'));}
        setBusy(true);
        const {error}=await supabase.rpc('change_task_status',{p_task_id:selectedTask.id,p_to_status:to,p_comment:comment});
        setBusy(false);
        if(error){message.error(error.message);throw error;}message.success('Отправлено на доработку');await reload();
      }});
      return;
    }
    void run(()=>supabase.rpc('change_task_status',{p_task_id:selectedTask.id,p_to_status:to,p_comment:null}),'Статус обновлён');
  };

  if(!configured)return <div className="centered"><Card style={{maxWidth:520}}><Title level={3}>Не настроен Supabase</Title><Paragraph>Создайте файл <Text code>.env</Text> по образцу <Text code>.env.example</Text>, укажите URL проекта и publishable/anon key, затем перезапустите <Text code>npm run dev</Text>.</Paragraph></Card></div>;
  if(!authReady)return <div className="centered"><Spin size="large"/></div>;
  if(!session)return <Login/>;
  if(!profile)return <div className="centered"><Card><Title level={4}>Профиль не найден</Title><Paragraph>Пользователь авторизован, но его роль ещё не назначена в таблице <Text code>public.profiles</Text>.</Paragraph><Space><Button onClick={()=>void reload()}>Обновить</Button><Button onClick={()=>supabase.auth.signOut()}>Выйти</Button></Space></Card></div>;

  const visibleTasks=active==='mine'?tasks.filter(t=>t.assignee_id===session.user.id):tasks.filter(t=>t.project_id===projectId);
  return <Layout className="app-shell">
    <Sider theme="light" breakpoint="lg" collapsedWidth="0" width={235} className="sidebar">
      <div className="brand"><ApartmentOutlined/><span>СтройКонтроль</span></div>
      <div className="sidebar-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <Menu mode="inline" selectedKeys={[active]} onClick={({key})=>{setActive(key as 'projects'|'mine');setProjectId(null);setTaskId(null);}} items={[{key:'projects',icon:<ApartmentOutlined/>,label:'Объекты'},...(!manager?[{key:'mine',icon:<CheckSquareOutlined/>,label:'Мои задачи'}]:[])]}/>
      <div className="sidebar-bottom"><SafetyOutlined/> Права защищены в базе</div>
    </Sider>
    <Layout>
      <Header className="topbar"><Text type="secondary">CRM / {active==='mine'?'Мои задачи':'Объекты'}</Text><Space><div className="user-caption"><strong>{profile.full_name}</strong><small>{manager?'Постановщик':'Исполнитель'}</small></div><Button icon={<LogoutOutlined/>} onClick={()=>void supabase.auth.signOut()}>Выйти</Button></Space></Header>
      <Content className="content">
        <div className="page-heading"><div><Text type="secondary">Управление строительством</Text><Title level={2} style={{margin:'4px 0 0'}}>{active==='mine'?'Мои задачи':selectedTask?'Карточка задачи':selectedProject?'Карточка объекта':'Объекты'}</Title></div><Space><Button icon={<ReloadOutlined/>} onClick={()=>void reload()} loading={loading}>Обновить</Button>{manager&&!selectedTask&&<Button type="primary" icon={<PlusOutlined/>} onClick={()=>selectedProject?openTask():openProject()}>{selectedProject?'Новая задача':'Новый объект'}</Button>}</Space></div>
        {active==='projects'&&<div className="crumbs"><a onClick={()=>{setProjectId(null);setTaskId(null);}}>Все объекты</a>{selectedProject&&<> / <a onClick={()=>setTaskId(null)}>{selectedProject.name}</a></>}{selectedTask&&<> / {selectedTask.title}</>}</div>}
        {active==='projects'&&!selectedProject&&<>
          <div className="stats"><Card><Statistic title="Объектов" value={projects.length}/></Card><Card><Statistic title="Всего задач" value={tasks.length}/></Card><Card><Statistic title="На проверке" value={tasks.filter(t=>t.status==='review').length}/></Card></div>
          {projects.length===0?<Card><Empty description="Нет доступных объектов"/></Card>:<div className="project-grid">{projects.map(p=><Card key={p.id} hoverable onClick={()=>{setProjectId(p.id);setTaskId(null);}} className="project-card"><div className="project-icon"><ApartmentOutlined/></div><Title level={4}>{p.name}</Title><Paragraph type="secondary">{p.address||'Адрес не указан'}</Paragraph><Space><Tag>{tasks.filter(t=>t.project_id===p.id).length} задач</Tag><Text type="secondary">Открыть →</Text></Space>{manager&&<div className="card-actions"><Button size="small" onClick={e=>{e.stopPropagation();openProject(p);}}>Изменить</Button><Button danger size="small" onClick={e=>{e.stopPropagation();remove('project',p.id);}}>Удалить</Button></div>}</Card>)}</div>}
        </>}
        {active==='projects'&&selectedProject&&!selectedTask&&<><Card className="detail-card"><Descriptions title={selectedProject.name} column={1} items={[{key:'address',label:'Адрес',children:selectedProject.address||'Не указан'},{key:'created',label:'Добавлен',children:prettyDate(selectedProject.created_at)}]}/></Card><div className="section-title"><Title level={4}>Задачи объекта</Title>{manager&&<Button icon={<PlusOutlined/>} onClick={()=>openTask()}>Добавить задачу</Button>}</div><TaskList tasks={visibleTasks} workers={workers} profile={profile} onOpen={setTaskId} onEdit={openTask} onDelete={id=>remove('task',id)}/></>}
        {active==='mine'&&!selectedTask&&<TaskList tasks={visibleTasks} workers={workers} profile={profile} onOpen={setTaskId} onEdit={openTask} onDelete={id=>remove('task',id)}/>}
        {selectedTask&&<><Card className="detail-card"><Space className="task-head" wrap><Title level={3} style={{margin:0}}>{selectedTask.title}</Title><StatusTag value={selectedTask.status}/></Space><Paragraph style={{marginTop:16}}>{selectedTask.description||'Описание отсутствует'}</Paragraph><Descriptions column={{xs:1,sm:2}} items={[{key:'project',label:'Объект',children:projects.find(p=>p.id===selectedTask.project_id)?.name||'—'},{key:'worker',label:'Исполнитель',children:currentWorker(selectedTask.assignee_id)},{key:'author',label:'Автор',children:manager?'Постановщик':'Постановщик'},{key:'created',label:'Создана',children:prettyDate(selectedTask.created_at)}]}/><Space wrap style={{marginTop:20}}>{actions[selectedTask.status].filter(a=>a.role===profile.role && (manager||selectedTask.assignee_id===session.user.id)).map(a=><Button key={a.to} type={a.to==='revision'?'default':'primary'} danger={a.to==='revision'} loading={busy} onClick={()=>changeStatus(a.to)}>{a.label}</Button>)}{manager&&<><Button onClick={()=>openTask(selectedTask)}>Редактировать</Button><Button danger onClick={()=>remove('task',selectedTask.id)}>Удалить</Button></>}</Space></Card><Card title="История изменений" className="detail-card"><Timeline items={history.map(h=>({children:<div><Space wrap><b>{statusName[h.from_status]} → {statusName[h.to_status]}</b><Text type="secondary">{prettyDate(h.changed_at)}</Text></Space><div className="history-actor">{h.actor_id===profile.id?profile.full_name:currentWorker(h.actor_id)}</div>{h.comment&&<Paragraph className="history-comment">{h.comment}</Paragraph>}</div>}))}/>{history.length===0&&<Empty description="Переходов статусов пока нет"/>}</Card></>}
      </Content>
    </Layout>
    <Modal open={dialog!==null} title={dialog==='project'?(editingId?'Редактировать объект':'Новый объект'):(editingId?'Редактировать задачу':'Новая задача')} okText="Сохранить" cancelText="Отмена" confirmLoading={busy} onCancel={()=>{setDialog(null);setEditingId(null);}} onOk={()=>form.submit()} destroyOnHidden><Form form={form} layout="vertical" onFinish={values=>void submitForm(values)} key={dialog+'-'+editingId}>
      {dialog==='project'?<><Form.Item label="Название" name="name" rules={[{required:true,message:'Укажите название'}]}><Input maxLength={160}/></Form.Item><Form.Item label="Адрес" name="address"><Input maxLength={500}/></Form.Item></>:<><Form.Item label="Название задачи" name="title" rules={[{required:true,message:'Укажите название'}]}><Input maxLength={160}/></Form.Item><Form.Item label="Описание" name="description"><Input.TextArea rows={4}/></Form.Item><Form.Item label="Объект" name="project_id" rules={[{required:true,message:'Выберите объект'}]}><Select options={projects.map(p=>({value:p.id,label:p.name}))}/></Form.Item><Form.Item label="Исполнитель" name="assignee_id" rules={[{required:true,message:'Выберите исполнителя'}]}><Select options={workers.map(w=>({value:w.id,label:w.full_name}))}/></Form.Item></>}
    </Form></Modal>
  </Layout>;
}
function TaskList({tasks,workers,profile,onOpen,onEdit,onDelete}:{tasks:Task[];workers:Profile[];profile:Profile;onOpen:(id:string)=>void;onEdit:(task:Task)=>void;onDelete:(id:string)=>void}){
  if(!tasks.length)return <Card><Empty description="Задач пока нет"/></Card>;
  return <Card className="detail-card"><List dataSource={tasks} renderItem={t=><List.Item actions={profile.role==='manager'?[<Button key="edit" type="link" onClick={()=>onEdit(t)}>Изменить</Button>,<Button key="delete" type="link" danger onClick={()=>onDelete(t.id)}>Удалить</Button>]:[]}><List.Item.Meta title={<a onClick={()=>onOpen(t.id)}>{t.title}</a>} description={<Space wrap><StatusTag value={t.status}/><Text type="secondary">{workers.find(w=>w.id===t.assignee_id)?.full_name||'Исполнитель'}</Text><Text type="secondary">{prettyDate(t.created_at)}</Text></Space>}/><Button size="small" onClick={()=>onOpen(t.id)}>Открыть</Button></List.Item>}/></Card>;
}
function Login(){
  const {message}=AntApp.useApp();const [busy,setBusy]=useState(false);
  const login=async(v:{email:string;password:string})=>{setBusy(true);const {error}=await supabase.auth.signInWithPassword(v);if(error)message.error(error.message);setBusy(false);};
  return <div className="login-page"><Card className="login-card"><div className="login-logo"><ApartmentOutlined/></div><Title level={2}>СтройКонтроль</Title><Paragraph type="secondary">Войдите в систему управления объектами и задачами</Paragraph><Form layout="vertical" onFinish={login} style={{marginTop:28}}><Form.Item name="email" label="Email" rules={[{required:true,type:'email',message:'Введите email'}]}><Input size="large" placeholder="you@company.ru" autoComplete="email"/></Form.Item><Form.Item name="password" label="Пароль" rules={[{required:true,message:'Введите пароль'}]}><Input.Password size="large" autoComplete="current-password"/></Form.Item><Button type="primary" htmlType="submit" size="large" loading={busy} block>Войти</Button></Form><Alert className="login-note" type="info" showIcon message="Учётные записи создаёт администратор. Открытой регистрации нет."/></Card></div>;
}
export default function App(){return <ConfigProvider><AntApp><CRM/></AntApp></ConfigProvider>}
