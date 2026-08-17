module.exports = {
  // client/shared 也要掃：共用元件的 class 若沒被掃到會「靜默」消失 ——
  // 建置不報錯、畫面直接裸奔。迴歸鎖：tests/shared_tailwind_scope_test.js
  content: ['./src/**/*.{js,jsx}', '../shared/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          primary: '#15316a',
          teal:    '#31aeab',
          green:   '#97bf36',
          amber:   '#e8a020',
          gold:    '#c9a84c',
          error:   '#d64545',
          'error-soft': '#fdecec',
          'error-strong': '#b53030',
        }
      },
      fontFamily: {
        sans: ['Noto Sans TC', 'Inter', 'sans-serif'],
      }
    }
  },
  plugins: []
}
