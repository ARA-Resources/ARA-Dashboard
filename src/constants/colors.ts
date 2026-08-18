/**
 * ARA Dashboard brand color tokens.
 * Keep these in sync with CSS variables in globals.css.
 */
export const COLORS = {
  primary: "#8E24AA",
  secondary: "#C2185B",
  highlight: "#E91E63",
  light: {
    background: "#FFFFFF",
    cards: "#FFFFFF",
    text: "#000000",
    headers: "#8E24AA",
    buttons: "#C2185B",
    icons: "#8E24AA",
  },
  dark: {
    background: "#0F0F12",
    sidebar: "#15151B",
    cards: "#1B1B24",
    text: "#FFFFFF",
    headers: "#8E24AA",
    buttons: "#C2185B",
    icons: "#FFFFFF",
  },
} as const;

export type ColorToken = typeof COLORS;
