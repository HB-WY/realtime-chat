// client/src/main.jsx（完整版）
import ReactDOM from 'react-dom/client';
import App from './App';
import { installCaptureGuards } from './utils/captureGuards';
import './styles/index.css';
import './styles/shop.css';
import './styles/appearance.css';
import './styles/apikeys.css';
import './styles/assets-stickers.css';
// 【新增】支付系统（转账 / 红包）
import './styles/payments.css';

// 「防随手抓取」的键盘守卫（F12 / Ctrl+Shift+I 等）。只拦快捷键，拦不住的有的是：
// 浏览器菜单照样能开开发者工具 —— 详见 utils/captureGuards.js 顶部说明。
installCaptureGuards();

ReactDOM.createRoot(document.getElementById('root')).render(<App />);