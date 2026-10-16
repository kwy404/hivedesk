# Notes for the site

## From lend (src/lend/, ui/lend/)

1. The Lend screen's share link and QR code point to
   `https://kwy404.github.io/hivedesk/lend/#w=word-word-word-word-word-word`
   (`LINK_BASE` in `ui/lend/core/link.js`). Please add a tiny `docs/lend/index.html` that reads
   the words from the hash (the regex `/[#&?]w=([A-Za-z-]+)/`) and shows them big, numbered 1
   to 6, with: "Open hivedesk on your computer, choose Use a friend's PC and enter these six
   words (or paste this link into the first box)." and the command
   `npx hivedesk --join "<the link>"`. Nothing is sent anywhere; the hash never reaches the server.
2. In the "Honest about the limits" section, lending facts you can quote: only prompts and
   answers travel; the friend's files are never read or written; the friend sees every request
   and can stop at any time; at most 20 requests per minute, prompts up to 120,000 characters,
   one request at a time; the pairing words expire after 10 minutes and work once; pairing uses
   public MQTT relays that only see a random topic and ciphertext; no TURN relay is built in,
   so two very strict networks may not connect.
