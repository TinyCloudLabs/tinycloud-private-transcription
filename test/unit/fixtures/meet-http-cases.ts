const targets = [
  { name: "exact HTTP code drops query on upgrade", input: "http://meet.google.com/ABC-DEFG-HIJ?authuser=1&pli=1", url: "https://meet.google.com/abc-defg-hij", nativeMeetingId: "abc-defg-hij" },
  { name: "HTTP lookup is refused", input: "http://meet.google.com/lookup/Team!", error: "invalid_meeting_url" },
  { name: "HTTP other host is refused", input: "http://example.com/abc-defg-hij", error: "invalid_meeting_url" },
] as const;

const wrappers = [
  { name: "direct", wrap: (target: string) => target },
  { name: "continue", wrap: (target: string) => `https://accounts.google.com/AccountChooser?continue=${encodeURIComponent(target)}` },
  { name: "Google q", wrap: (target: string) => `https://www.google.com/url?q=${encodeURIComponent(target)}` },
  { name: "Google url", wrap: (target: string) => `https://www.google.com/url?url=${encodeURIComponent(target)}` },
  { name: "app link", wrap: (target: string) => `https://meet.app.goo.gl/?link=${encodeURIComponent(target)}` },
];

export const meetHttpCases = [
  ...wrappers.flatMap(({ name, wrap }) => targets.map((row) => ({ ...row, name: `${name}: ${row.name}`, input: wrap(row.input) }))),
  { name: "canonical HTTP code upgrades", input: "http://meet.google.com/abc-defg-hij", url: "https://meet.google.com/abc-defg-hij", nativeMeetingId: "abc-defg-hij" },
  ...[
    "http://meet.google.com/abc-defg-hij/",
    "http://meet.google.com/meet/abc-defg-hij",
    "http://meet.google.com/_meet/abc-defg-hij",
    "http://meet.google.com/abcdefghij",
    "http://sub.meet.google.com/abc-defg-hij",
    "http://meet.google.com.evil.com/abc-defg-hij",
    "http://evilmeet.google.com/abc-defg-hij",
    "http://tel.meet/abc-defg-hij?pin=1",
    "http://g.co/meet/abc-defg-hij",
  ].map((input) => ({ name: `selected HTTP target refused: ${input}`, input, error: "invalid_meeting_url" } as const)),
  ...wrappers.slice(1).map(({ name, wrap }) => ({ name: `HTTP outer ${name} wrapper is refused`, input: wrap("https://meet.google.com/abc-defg-hij").replace(/^https:/, "http:"), error: "invalid_meeting_url" } as const)),
  { name: "HTTPS query handling is unchanged", input: "https://meet.google.com/abc-defg-hij?authuser=1", url: "https://meet.google.com/abc-defg-hij?authuser=1", nativeMeetingId: "abc-defg-hij" },
  { name: "unrelated HTTP prose URL does not replace a later Meet target", input: "Notes http://example.com/agenda Meet https://meet.google.com/abc-defg-hij", url: "https://meet.google.com/abc-defg-hij", nativeMeetingId: "abc-defg-hij" },
];
