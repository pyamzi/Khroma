# Khroma never computes, stores, or searches faces

Khroma describes each uploaded photo with an AI model so Studios can search their Library, and many of those photos show Clients. We decided on 2026-09-30 that the product never computes face geometry, face embeddings, or "same person" matches, and never puts names or identities into image descriptions. Illinois BIPA and Texas CUBI regulate scans of face geometry with per-violation penalties, while scene descriptions of photographs fall outside those definitions; staying on that side of the line is worth more to a solo-founder business than a "find every photo of this person" feature.

## Consequences

- Image descriptions describe scene content only (setting, light, clothing, activity), and the privacy policy says so.
- Any future request for face search, face clustering, or person tagging needs a new decision record and legal review first.
