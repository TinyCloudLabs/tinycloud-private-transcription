export const meetInviteCases = [
  {
    "name": "Sam's exact calendar invite",
    "input": "TinyCloud Team Sync Wednesday, October 28 · 8:00 – 8:30am Time zone: America/New_York Google Meet joining info Video call link: https://meet.google.com/yas-buib-ppd Or dial: (DE) +49 30 300195060 PIN: 933 894 199 6748# More phone numbers: https://tel.meet/yas-buib-ppd?pin=9338941996748",
    "url": "https://meet.google.com/yas-buib-ppd",
    "nativeMeetingId": "yas-buib-ppd"
  },
  {
    "name": "no Meet URL among phone and dial-in details",
    "input": "Team Sync 8:00am Or dial +49 30 300195060 PIN 933 894 199 6748# More numbers https://tel.meet/yas-buib-ppd?pin=9338941996748",
    "error": "invalid_meeting_url"
  },
  {
    "name": "first exact Meet URL after unrelated and dial-in links",
    "input": "Notes https://example.com/notes Dial https://tel.meet/klm-nopq-rst?pin=1 Video https://meet.google.com/abc-defg-hij Backup https://meet.google.com/yas-buib-ppd",
    "url": "https://meet.google.com/abc-defg-hij",
    "nativeMeetingId": "abc-defg-hij"
  },
  {
    "name": "first lookup retains its nickname and query instead of selecting a later code",
    "input": "Join https://meet.google.com/lookup/TeamFirst?authuser=1 Backup https://meet.google.com/yas-buib-ppd",
    "url": "https://meet.google.com/lookup/TeamFirst?authuser=1",
    "nativeMeetingId": "TeamFirst"
  },
  {
    "name": "first HTTP lookup follows the existing refusal rule",
    "input": "Join http://meet.google.com/lookup/TeamFirst Backup https://meet.google.com/yas-buib-ppd",
    "error": "invalid_meeting_url"
  },
  {
    "name": "lookalike and userinfo hosts are not Meet links",
    "input": "Join https://meet.google.com.evil.com/abc-defg-hij or https://evilmeet.google.com/klm-nopq-rst or https://meet.google.com@evil.com/yas-buib-ppd",
    "error": "invalid_meeting_url"
  },
  {
    "name": "a Meet URL at the start of text is extracted",
    "input": "https://meet.google.com/abc-defg-hij is the first call; backup https://meet.google.com/yas-buib-ppd",
    "url": "https://meet.google.com/abc-defg-hij",
    "nativeMeetingId": "abc-defg-hij"
  },
  {
    "name": "sentence punctuation and code casing use existing normalization",
    "input": "Join (https://meet.google.com/YAS-BUIB-PPD/). Or dial +49 30 300195060",
    "url": "https://meet.google.com/yas-buib-ppd",
    "nativeMeetingId": "yas-buib-ppd"
  },
  {
    "name": "a non-Meet URL query is not followed while scanning text",
    "input": "Notes https://evil.com/?next=https://meet.google.com/abc-defg-hij More information follows",
    "error": "invalid_meeting_url"
  },
  {
    "name": "first schemeless lookup keeps the approved lookup rules",
    "input": "Join meet.google.com/lookup/TeamBareFirst?authuser=1 Backup https://meet.google.com/yas-buib-ppd",
    "url": "https://meet.google.com/lookup/TeamBareFirst?authuser=1",
    "nativeMeetingId": "TeamBareFirst"
  },
  {
    "name": "a URL inside a text label without spaces is extracted",
    "input": "Calendar(https://meet.google.com/yas-buib-ppd)",
    "url": "https://meet.google.com/yas-buib-ppd",
    "nativeMeetingId": "yas-buib-ppd"
  },
  {
    "name": "angle-delimited lookup nickname punctuation is preserved",
    "input": "Join <https://meet.google.com/lookup/Team!> Backup https://meet.google.com/yas-buib-ppd",
    "url": "https://meet.google.com/lookup/Team!",
    "nativeMeetingId": "Team!"
  },
  {
    "name": "angle-delimited lookup query punctuation is preserved",
    "input": "Join <https://meet.google.com/lookup/Team?hint=one!> Backup https://meet.google.com/yas-buib-ppd",
    "url": "https://meet.google.com/lookup/Team?hint=one!",
    "nativeMeetingId": "Team"
  },
  {
    "name": "unquoted lookup nickname punctuation remains URL content",
    "input": "Join https://meet.google.com/lookup/Team! Backup https://meet.google.com/yas-buib-ppd",
    "url": "https://meet.google.com/lookup/Team!",
    "nativeMeetingId": "Team!"
  },
  {
    "name": "label parentheses preserve enclosed lookup query parentheses",
    "input": "Join Calendar(https://meet.google.com/lookup/Team!?hint=(one)) Backup https://meet.google.com/yas-buib-ppd",
    "url": "https://meet.google.com/lookup/Team!?hint=(one)",
    "nativeMeetingId": "Team!"
  },
  {
    "name": "first HTTP dashed-code target is not skipped for a later meeting",
    "input": "Join http://meet.google.com/abc-defg-hij Backup https://meet.google.com/yas-buib-ppd",
    "url": "https://meet.google.com/abc-defg-hij",
    "nativeMeetingId": "abc-defg-hij"
  }
] as const;
