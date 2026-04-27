import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { parseOptions } from "./utils";

/**
 * Implementation of the 'date' command.
 *
 * Supported options:
 *   -u, --utc, --universal    Use UTC instead of local time
 *   -d, --date=STRING         Display time described by STRING (parsable date)
 *   -I[FMT], --iso-8601[=FMT] Output ISO 8601 format (date|hours|minutes|seconds|ns)
 *   -R, --rfc-email           Output date/time in RFC 5322 format
 *   -r, --reference=FILE      (accepted; not meaningful over VFS)
 *   +FORMAT                   Format output according to FORMAT
 *
 * Supported conversion specifiers (a pragmatic GNU subset):
 *   %Y %y %C %m %d %e %j %H %I %M %S %N %p %P %A %a %B %b %h
 *   %F (=%Y-%m-%d) %T (=%H:%M:%S) %D (=%m/%d/%y) %R (=%H:%M)
 *   %r (%I:%M:%S %p) %s %u (1..7) %w (0..6) %Z %z %n %t %%
 */
export class DateCommand implements ShellCommand {
  name = 'date';
  description = 'Display current date and time';
  usage = 'date [-uR] [-d STRING] [-I[FMT]] [+FORMAT]';

  async execute(args: string[], _cwd: string, _input?: string): Promise<ShellCommandResult> {
    // Treat +FORMAT as an operand and everything else via parseOptions.
    const parsed = parseOptions(args, {
      booleanShort: ['u', 'R'],
      valueShort: ['d', 'r', 'I'],
      booleanLong: ['utc', 'universal', 'rfc-email'],
      valueLong: ['date', 'reference', 'iso-8601'],
      longToShort: {
        utc: 'u',
        universal: 'u',
        'rfc-email': 'R',
        date: 'd',
        reference: 'r',
        'iso-8601': 'I',
      },
    });

    if (parsed.unknown.length > 0) {
      // Unknown options starting with `-` that are NOT `+FORMAT`.
      const u = parsed.unknown[0];
      if (!u.startsWith('+')) {
        return createErrorResult(`${this.name}: invalid option -- '${u.replace(/^-+/, '')}'`);
      }
    }

    const useUtc = parsed.flags.has('u');
    const rfcEmail = parsed.flags.has('R');
    const isoArg = parsed.values.get('I');
    const dateArg = parsed.values.get('d');

    let date: Date;
    if (dateArg) {
      const parsedDate = new Date(dateArg);
      if (isNaN(parsedDate.getTime())) {
        return createErrorResult(`${this.name}: invalid date '${dateArg}'`);
      }
      date = parsedDate;
    } else {
      date = new Date();
    }

    // Find +FORMAT among operands or unknowns. Non-+ operands are invalid
    // when used without -d / -r.
    let formatStr: string | undefined;
    for (const op of parsed.operands) {
      if (op.startsWith('+')) {
        formatStr = op.slice(1);
      } else if (!dateArg && !parsed.values.has('r')) {
        return createErrorResult(`${this.name}: invalid date '${op}'`);
      }
    }
    for (const u of parsed.unknown) {
      if (u.startsWith('+')) formatStr = u.slice(1);
    }

    if (rfcEmail) {
      return createSuccessResult(formatRfcEmail(date, useUtc) + '\n');
    }

    if (isoArg !== undefined) {
      return createSuccessResult(formatIso(date, isoArg, useUtc) + '\n');
    }

    if (formatStr !== undefined) {
      return createSuccessResult(formatDate(date, formatStr, useUtc) + '\n');
    }

    // Default: POSIX `Day Mon DD HH:MM:SS TZ YYYY`.
    return createSuccessResult(formatDate(date, '%a %b %e %H:%M:%S %Z %Y', useUtc) + '\n');
  }
}

function formatDate(date: Date, format: string, utc: boolean): string {
  const g = accessors(date, utc);
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c !== '%' || i + 1 >= format.length) {
      out += c;
      continue;
    }
    const spec = format[i + 1];
    i++;
    switch (spec) {
      case '%': out += '%'; break;
      case 'Y': out += String(g.year).padStart(4, '0'); break;
      case 'y': out += String(g.year % 100).padStart(2, '0'); break;
      case 'C': out += String(Math.floor(g.year / 100)).padStart(2, '0'); break;
      case 'm': out += pad2(g.month + 1); break;
      case 'd': out += pad2(g.day); break;
      case 'e': out += String(g.day).padStart(2, ' '); break;
      case 'j': out += String(dayOfYear(date, utc)).padStart(3, '0'); break;
      case 'H': out += pad2(g.hour); break;
      case 'I': out += pad2(((g.hour + 11) % 12) + 1); break;
      case 'M': out += pad2(g.minute); break;
      case 'S': out += pad2(g.second); break;
      case 'N': out += String(g.ms * 1_000_000).padStart(9, '0'); break;
      case 'p': out += g.hour < 12 ? 'AM' : 'PM'; break;
      case 'P': out += g.hour < 12 ? 'am' : 'pm'; break;
      case 'A': out += date.toLocaleDateString('en-US', { weekday: 'long', timeZone: utc ? 'UTC' : undefined }); break;
      case 'a': out += date.toLocaleDateString('en-US', { weekday: 'short', timeZone: utc ? 'UTC' : undefined }); break;
      case 'B': out += date.toLocaleDateString('en-US', { month: 'long', timeZone: utc ? 'UTC' : undefined }); break;
      case 'b':
      case 'h': out += date.toLocaleDateString('en-US', { month: 'short', timeZone: utc ? 'UTC' : undefined }); break;
      case 'F': out += `${String(g.year).padStart(4, '0')}-${pad2(g.month + 1)}-${pad2(g.day)}`; break;
      case 'T': out += `${pad2(g.hour)}:${pad2(g.minute)}:${pad2(g.second)}`; break;
      case 'D': out += `${pad2(g.month + 1)}/${pad2(g.day)}/${String(g.year % 100).padStart(2, '0')}`; break;
      case 'R': out += `${pad2(g.hour)}:${pad2(g.minute)}`; break;
      case 'r': {
        const h12 = ((g.hour + 11) % 12) + 1;
        out += `${pad2(h12)}:${pad2(g.minute)}:${pad2(g.second)} ${g.hour < 12 ? 'AM' : 'PM'}`;
        break;
      }
      case 's': out += String(Math.floor(date.getTime() / 1000)); break;
      case 'u': { const dow = g.weekday; out += String(dow === 0 ? 7 : dow); break; }
      case 'w': out += String(g.weekday); break;
      case 'Z': out += utc ? 'UTC' : tzAbbrev(date); break;
      case 'z': out += utc ? '+0000' : tzOffset(date); break;
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      default: out += '%' + spec;
    }
  }
  return out;
}

function accessors(date: Date, utc: boolean) {
  if (utc) {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
      ms: date.getUTCMilliseconds(),
      weekday: date.getUTCDay(),
    };
  }
  return {
    year: date.getFullYear(),
    month: date.getMonth(),
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    ms: date.getMilliseconds(),
    weekday: date.getDay(),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function dayOfYear(date: Date, utc: boolean): number {
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const start = utc ? Date.UTC(year, 0, 0) : new Date(year, 0, 0).getTime();
  const diff = date.getTime() - start;
  return Math.floor(diff / 86_400_000);
}

function tzOffset(date: Date): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
}

function tzAbbrev(date: Date): string {
  // Best-effort: derive something human-readable.
  const match = /\(([^)]+)\)$/.exec(date.toString());
  return match ? match[1].replace(/[^A-Z]/g, '') || 'UTC' : 'UTC';
}

function formatIso(date: Date, precision: string, utc: boolean): string {
  const g = accessors(date, utc);
  const dateStr = `${String(g.year).padStart(4, '0')}-${pad2(g.month + 1)}-${pad2(g.day)}`;
  const tz = utc ? '+00:00' : isoTzOffset(date);
  switch (precision) {
    case '':
    case 'date':
      return dateStr;
    case 'hours':
      return `${dateStr}T${pad2(g.hour)}${tz}`;
    case 'minutes':
      return `${dateStr}T${pad2(g.hour)}:${pad2(g.minute)}${tz}`;
    case 'seconds':
      return `${dateStr}T${pad2(g.hour)}:${pad2(g.minute)}:${pad2(g.second)}${tz}`;
    case 'ns':
      return `${dateStr}T${pad2(g.hour)}:${pad2(g.minute)}:${pad2(g.second)},${String(g.ms * 1_000_000).padStart(9, '0')}${tz}`;
    default:
      return dateStr;
  }
}

function isoTzOffset(date: Date): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function formatRfcEmail(date: Date, utc: boolean): string {
  const g = accessors(date, utc);
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short', timeZone: utc ? 'UTC' : undefined });
  const month = date.toLocaleDateString('en-US', { month: 'short', timeZone: utc ? 'UTC' : undefined });
  return `${weekday}, ${pad2(g.day)} ${month} ${g.year} ${pad2(g.hour)}:${pad2(g.minute)}:${pad2(g.second)} ${utc ? '+0000' : tzOffset(date)}`;
}
