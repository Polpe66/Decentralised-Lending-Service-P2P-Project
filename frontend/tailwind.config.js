/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b0e14",
        panel: "#141925",
        panel2: "#1c2333",
        line: "#2a3349",
      },
    },
  },
  plugins: [],
};
