// ── Tiny TTY prompt kit (no dependencies) ──────────────────────────
// Arrow keys where the terminal allows it, plain numbered input where it does
// not (piped stdin, CI). Every prompt has a default so Enter always works.

const COLOR = Boolean(process.stdout.isTTY);
const c = (code: string, s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
export const ui = {
  dim: (s: string) => c("2", s),
  bold: (s: string) => c("1", s),
  cyan: (s: string) => c("36", s),
  green: (s: string) => c("32", s),
  yellow: (s: string) => c("33", s),
  red: (s: string) => c("31", s),
};

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

const write = (s: string) => process.stdout.write(s);
const isRaw = () => Boolean(process.stdin.isTTY && process.stdin.setRawMode);

// ── stdin, read once and shared ────────────────────────────────────
// A single persistent listener with a buffer. Attaching `once("data")` per
// prompt loses input whenever a chunk carries more than one answer, which is
// exactly what happens when the answers are piped in rather than typed.

type Pending =
  | { kind: "key"; resolve: (s: string) => void }
  | { kind: "line"; resolve: (s: string) => void };

const ESC = String.fromCharCode(27);
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BRACKET = String.fromCharCode(92) + "[";

let buffer = "";
const pending: Pending[] = [];
let listening = false;

/**
 * Split one answer off the front of the buffer.
 *
 * `key` takes a whole escape sequence when the buffer starts with one, so an
 * arrow key arrives as a single token instead of three. `line` waits for a
 * newline and returns null until it has one, which is what makes a single
 * chunk carrying several answers work.
 */
export function nextToken(
  buf: string,
  kind: "key" | "line",
): { token: string; rest: string } | null {
  if (!buf) return null;
  if (kind === "key") {
    const esc = buf.match(new RegExp("^" + ESC + "(" + BRACKET + "[0-9;]*[A-Za-z])?"));
    const token = esc ? esc[0] : buf.slice(0, 1);
    return { token, rest: buf.slice(token.length) };
  }
  const nl = buf.indexOf(NL);
  if (nl === -1) return null;
  return {
    token: buf.slice(0, nl).replace(new RegExp(CR + "$"), ""),
    rest: buf.slice(nl + 1),
  };
}

function drain(): void {
  while (pending.length && buffer.length) {
    const next = pending[0];
    const got = nextToken(buffer, next.kind);
    if (!got) return; // an incomplete line — wait for the rest
    buffer = got.rest;
    pending.shift();
    next.resolve(got.token);
  }
}

function listen(): void {
  if (listening) return;
  listening = true;
  process.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    drain();
  });
  process.stdin.resume();
}

function request(kind: "key" | "line"): Promise<string> {
  listen();
  return new Promise<string>((resolve) => {
    pending.push({ kind, resolve } as Pending);
    drain();
  });
}

/** One keypress. Raw mode when the terminal allows it. */
async function readKey(): Promise<string> {
  process.stdin.setRawMode?.(true);
  const key = await request("key");
  process.stdin.setRawMode?.(false);
  return key;
}

/** One line of input (works with or without a TTY). */
export function readLine(): Promise<string> {
  process.stdin.setRawMode?.(false);
  return request("line");
}

/** Release stdin so the process can exit or hand the terminal to a child. */
export function releaseStdin(): void {
  process.stdin.pause();
}

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

function renderChoices<T>(title: string, choices: Choice<T>[], active: number): void {
  write(`\n${ui.bold(title)}\n`);
  choices.forEach((ch, i) => {
    const on = i === active;
    const bullet = on ? ui.cyan("❯") : " ";
    const label = on ? ui.cyan(ch.label) : ch.label;
    const hint = ch.hint ? ui.dim(`  ${ch.hint}`) : "";
    write(`${bullet} ${ui.dim(`${i + 1}.`)} ${label}${hint}\n`);
  });
  write(ui.dim("  ↑/↓ pilih · angka langsung · Enter oke · Ctrl-C batal\n"));
}

/** Single choice. Returns the chosen value, throws Cancelled on Ctrl-C. */
export async function select<T>(
  title: string,
  choices: Choice<T>[],
  defaultIndex = 0,
): Promise<T> {
  if (!isRaw()) {
    renderChoices(title, choices, defaultIndex);
    write(`${ui.dim(`pilih [1-${choices.length}] (${defaultIndex + 1}): `)}`);
    const line = (await readLine()).trim();
    const n = line === "" ? defaultIndex + 1 : Number(line);
    const idx = Number.isFinite(n) && n >= 1 && n <= choices.length ? n - 1 : defaultIndex;
    return choices[idx].value;
  }

  let active = defaultIndex;
  let drawn = 0;
  const draw = () => {
    if (drawn) write(`\x1b[${drawn}A\x1b[0J`);
    renderChoices(title, choices, active);
    drawn = choices.length + 3;
  };
  draw();

  for (;;) {
    const key = await readKey();
    if (key === "\x03" || key === "\x1b") throw new Cancelled();
    if (key === "\x1b[A" || key === "k") active = (active - 1 + choices.length) % choices.length;
    else if (key === "\x1b[B" || key === "j") active = (active + 1) % choices.length;
    else if (/^[1-9]$/.test(key) && Number(key) <= choices.length) {
      active = Number(key) - 1;
      draw();
      return choices[active].value;
    } else if (key === "\r" || key === "\n") {
      return choices[active].value;
    }
    draw();
  }
}

/** Yes/no with a default. */
export async function confirm(title: string, defaultYes = true): Promise<boolean> {
  return select<boolean>(
    title,
    [
      { value: true, label: "Ya" },
      { value: false, label: "Tidak" },
    ],
    defaultYes ? 0 : 1,
  );
}

/** A number with a default; blank input keeps the default. */
export async function askNumber(title: string, def: number, unit = ""): Promise<number> {
  write(`\n${ui.bold(title)} ${ui.dim(`(${def}${unit}, Enter = default)`)}\n> `);
  const line = (await readLine()).trim();
  if (line === "") return def;
  const n = Number(line);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/** Free-form text input with a default; blank input keeps the default. */
export async function askText(title: string, def = ""): Promise<string> {
  const hint = def ? ` (${def}, Enter = default)` : "";
  write(`\n${ui.bold(title)}${ui.dim(hint)}\n> `);
  const line = (await readLine()).trim();
  return line === "" ? def : line;
}
