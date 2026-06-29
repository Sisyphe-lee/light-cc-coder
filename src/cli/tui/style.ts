// SGR styling as pure string builders. When `enabled` is false every helper is
// the identity function, which keeps renderer snapshot tests readable (no escape
// codes) and lets us disable color on non-TTY or NO_COLOR environments.

const CSI = "\x1b["
const RESET = `${CSI}0m`

export type Style = (text: string) => string

export type Styles = {
  bold: Style
  dim: Style
  inverse: Style
  green: Style
  red: Style
  yellow: Style
  cyan: Style
  blue: Style
  magenta: Style
  gray: Style
}

export function makeStyles(enabled: boolean): Styles {
  const wrap =
    (open: string): Style =>
    (text) =>
      enabled ? `${open}${text}${RESET}` : text
  return {
    bold: wrap(`${CSI}1m`),
    dim: wrap(`${CSI}2m`),
    inverse: wrap(`${CSI}7m`),
    green: wrap(`${CSI}32m`),
    red: wrap(`${CSI}31m`),
    yellow: wrap(`${CSI}33m`),
    cyan: wrap(`${CSI}36m`),
    blue: wrap(`${CSI}34m`),
    magenta: wrap(`${CSI}35m`),
    gray: wrap(`${CSI}90m`),
  }
}
