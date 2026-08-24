/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./App.js', './src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        /**
         * Tailwind's `blue` is DELIBERATELY overridden with the Vyapaar navy.
         *
         * Every primary button, active pill and selected row in the app already
         * says bg-blue-600 / text-blue-700 / bg-blue-50, so remapping the scale
         * rebrands all of them at once and -- more importantly -- makes it
         * impossible for a future screen to reach a generic blue by accident.
         * Renaming ~35 class usages across 15 files instead would leave the old
         * blue one careless `bg-blue-500` away from coming back.
         *
         * Derived from #00466B by blending toward white (tints) and #00111F
         * (shades). Every pair the app relies on clears WCAG AAA:
         *   white on 600  10.06:1     white on 700  13.21:1
         *   700 on 50     11.72:1     600 on white  10.06:1
         */
        blue: {
          50: '#EDF2F5',
          100: '#D6E1E7',
          500: '#1A587A',
          600: '#00466B',
          700: '#003350',
        },
        brand: {
          navy: '#00466B',
          navyDeep: '#003350',
          /**
           * The logo's swoosh teal. GRAPHIC USE ONLY: as text on white it is
           * 2.57:1, and as a surface under white text also 2.57:1 -- it fails
           * both ways. For teal-flavoured text or icons use `tealText`; for a
           * teal surface that must carry white text use `tealDeep`.
           */
          teal: '#1FB5A0',
          tealDeep: '#118388',
          tealText: '#147C73',
          ink: '#00111F',
          canvas: '#F8F8F8',
        },
      },
    },
  },
  plugins: [],
};
