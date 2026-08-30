# Chrome Web Store readiness

This is a product-risk checklist, not legal advice.

## Recommended Store edition

Publish a separate edition with:

- Neutral generated avatars as the default and only bundled remote-free source
- An optional user-supplied avatar pack, if desired
- No Gelbooru code, URL, host permission, screenshots, or listing references
- Only `storage` permission and the narrow `https://onlyfans.com/*` host scope
- No reading, storage, or modification of message bodies
- No sending, auto-replies, bulk export, scraping, downloads, or account actions
- A prominent first-run disclosure and affirmative consent before masking
- A public privacy-policy URL that matches the extension’s behavior
- Accurate data-use declarations in the Web Store dashboard
- A clear single purpose: locally pseudonymizing fan identities

## Why the personal build should not be submitted unchanged

Chrome Web Store policy does not allow sexually explicit material or content
that drives traffic to commercial pornography sites. Reviewers also assess the
entire extension experience and listing. A feature that retrieves images from
Gelbooru can expose adult material and adds copyright and third-party-service
questions even when the query requests general-rated images.

Gelbooru’s terms say the site is for personal use and prohibit automated
retrieval/indexing, while separately setting conditions for API data and
directly served content. A broadly distributed extension should get written
permission or avoid the integration.

The extension also handles usernames, numeric account identifiers, webpage
content, and personal communications context. Chrome treats these as user data
even when processing and storage stay local, so disclosure and a privacy policy
are required.

The personal **Creator Workflow Toolkit** also contains multi-site uploader
presets, tag automation, an OnlyFans selection helper, and an OnlyFans follow
helper. Those features broaden both host access and purpose, and some activate
authenticated account controls. They remain intentionally excluded from the
store-safe **Fan Identity Mask** edition.

## OnlyFans terms and account risk

The store edition is deliberately display-only. It observes markup already loaded
by a user’s normal browser session and changes only the local presentation. It
does not automate navigation, extract data to a server, bypass access controls,
or send messages.

That design lowers risk but does not guarantee compliance with OnlyFans’
contractual terms or local law. Before public distribution, obtain current
written platform guidance and jurisdiction-specific legal advice.
