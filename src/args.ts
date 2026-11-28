// A tiny option parser: `--opt value`, `--opt=value`, boolean `--flag`, short aliases, the rest positional.
import { die } from "./util.ts";

export interface Spec {
  /** Options that take a value. */
  opts?: string[];
  /** Boolean flags. */
  flags?: string[];
  /** -f → --force */
  alias?: Record<string, string>;
  /** Accepted and dropped (old options), with whether they take a value. */
  ignored?: Record<string, boolean>;
}

export interface Parsed {
  pos: string[];
  opt: Record<string, string | undefined>;
  flag: Record<string, boolean>;
}

export function parse(args: string[], spec: Spec, usage: string): Parsed {
  const pos: string[] = [];
  const opt: Record<string, string | undefined> = {};
  const flag: Record<string, boolean> = {};
  const opts = new Set(spec.opts ?? []);
  const flags = new Set(spec.flags ?? []);
  for (let i = 0; i < args.length; i++) {
    let a = args[i]!;
    if (a === "--") {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (a === "--help" || a === "-h") {
      process.stdout.write(`usage: ${usage}\n`);
      process.exit(0);
    }
    if (spec.alias?.[a]) a = spec.alias[a]!;
    if (!a.startsWith("--") || a === "--") {
      if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) die(`unknown option ${a}\nusage: ${usage}`);
      pos.push(a);
      continue;
    }
    let name = a.slice(2);
    let value: string | undefined;
    const eq = name.indexOf("=");
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (spec.ignored && name in spec.ignored) {
      if (spec.ignored[name] && value === undefined) i++;
      continue;
    }
    if (opts.has(name)) {
      if (value === undefined) {
        value = args[++i];
        if (value === undefined) die(`--${name} needs a value\nusage: ${usage}`);
      }
      // Given again: the values pile up, one per line (lists like --verify).
      opt[name] = opt[name] === undefined ? value : `${opt[name]}\n${value}`;
    } else if (flags.has(name)) {
      flag[name] = true;
    } else {
      die(`unknown option --${name}\nusage: ${usage}`);
    }
  }
  return { pos, opt, flag };
}
