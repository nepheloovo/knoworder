import base from '../../vite.config';

// 截图专用：前端跑在 4174，接口指向独立的演示后端 8002，不碰本地开发数据
export default {
  ...base,
  server: { ...base.server, port: 4174, proxy: { '/api': { target: 'http://127.0.0.1:8002', changeOrigin: true } } },
};
