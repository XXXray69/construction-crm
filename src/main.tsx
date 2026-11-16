import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import App from './App';
import './style.css';
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider theme={{token:{colorPrimary:'#2563eb',borderRadius:10,fontFamily:'Inter, system-ui, Arial'}}}><App/></ConfigProvider></React.StrictMode>);
