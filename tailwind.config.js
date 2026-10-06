/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/*.html', './public/*.js'],
  theme: {
    extend: {
      borderRadius: {
        '2xl': '1rem',
      },
    },
  },
  plugins: [],
};
