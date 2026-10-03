import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    // 构建配置 / 脚本运行在 Node 下，需要 Node 全局变量（process 等）
    files: ['*.config.js', 'vite.config.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // eslint-plugin-react-hooks v7 新增的严格规则：禁止在 effect 里调用会
      // setState 的函数（面向 React Compiler 的「不要在 effect 里取数据」建议）。
      // 本项目（以及全部 admin 面板 / useRole / usePreferences 等）一直采用
      // 「挂载后拉一次数据」的写法，且已用 alive 标志处理卸载竞态，
      // 不属于 bug。这里降级为 warning：保留提示，但不让 lint 整体失败。
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
])
