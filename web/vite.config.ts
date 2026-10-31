import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command, mode }) => {
  // On hosted builds (Vercel, Cloudflare Pages) the API lives on another origin. Without VITE_API_URL the bundle would
  // silently call its own origin and every request would fail, so stop the deploy with an actionable message instead.
  if (command === 'build' && (process.env.VERCEL || process.env.CF_PAGES)) {
    const env = loadEnv(mode, process.cwd(), 'VITE_');
    const apiUrl = env.VITE_API_URL || '';
    if (!/^https:\/\/.+/i.test(apiUrl)) {
      throw new Error(`VITE_API_URL must be set to the deployed API, e.g. https://your-api.onrender.com/api (got "${apiUrl || 'nothing'}"). Add it in the hosting project's environment variables and redeploy.`);
    }
  }
  return {
    plugins: [react()],
    server: {
      port: 5173,
    },
  };
});
