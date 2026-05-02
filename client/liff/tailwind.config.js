module.exports = {
  content: ['./src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          primary: '#15316a',
          teal:    '#31aeab',
          green:   '#97bf36',
          amber:   '#e8a020',
          gold:    '#c9a84c',
        }
      },
      fontFamily: {
        sans: ['Noto Sans TC', 'Inter', 'sans-serif'],
      }
    }
  },
  plugins: []
}
