# User Prompts

This lab-local prompt is applied after the core Lab Agent prompt and the Raman
extension prompt.

Current lab defaults:

- Treat Raman as the active MVP domain.
- Prefer simulation or offline planning when live hardware state is unknown or
  unavailable.
- For live work, use the configured Raman runtime under `.pi/raman-lab-config`
  and report unavailable resources plainly.
- Keep experiment identifiers, run identifiers, and artifact paths stable and
  explicit so records can be traced after the conversation is compacted.
