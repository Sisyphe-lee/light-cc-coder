// SGR styling as pure string builders. When `enabled` is false every helper is
// the identity function, which keeps renderer snapshot tests readable (no escape
// codes) and lets us disable color on non-TTY or NO_COLOR environments.

const CSI = "\x1b["
const RESET = `${CSI}0m`

export type Style = (text: string) => string

export type Styles = {
  enabled: boolean
  bold: Style
  dim: Style
  inverse: Style
  green: Style
  red: Style
  yellow: Style
  cyan: Style
  cyanBold: Style
  blue: Style
  magenta: Style
  gray: Style
  header: Style
}

export function makeStyles(enabled: boolean): Styles {
  const wrap =
    (open: string): Style =>
    (text) =>
      enabled ? `${open}${text}${RESET}` : text
  return {
    enabled,
    bold: wrap(`${CSI}1m`),
    dim: wrap(`${CSI}2m`),
    inverse: wrap(`${CSI}7m`),
    green: wrap(`${CSI}38;5;78m`),
    red: wrap(`${CSI}38;5;203m`),
    yellow: wrap(`${CSI}38;5;221m`),
    cyan: wrap(`${CSI}38;5;45m`),
    cyanBold: wrap(`${CSI}1;38;5;45m`),
    blue: wrap(`${CSI}38;5;75m`),
    magenta: wrap(`${CSI}38;5;176m`),
    gray: wrap(`${CSI}38;5;245m`),
    header: wrap(`${CSI}1;38;5;39m`),
  }
}
