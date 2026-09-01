# Authenticated Chrome smoke test

This smoke proves current X page semantics without publishing anything.

1. Use a disposable teaser fixture and a non-live catalogue bridge/audit root.
2. In Chrome, sign in to X and open the X teaser recorder.
3. Select the fixture and explicitly choose the fixture catalogue row. Press **Yes — pair and open X**.
4. Do not press X's final **Post** control. Instead, navigate the bound X tab to an existing harmless video status owned by the test account.
5. Expected: exactly one status article is accepted only when it has a canonical numeric status URL, ISO `<time>`, video duration, and `twimg.com` poster. Multiple articles, a sensitive-content reveal gate, or missing metadata must stop with no audit, Sheet append, or move.
6. For a full fixture rehearsal, use a deliberately isolated bridge and audit tree. Verify one receipt, three frames, one column-O URL, and the source in `Done` in that order.

Live X posting, the live Work Sheet, and real media roots remain separately authorized gates. This release observes the result but never clicks X's final Post button.
