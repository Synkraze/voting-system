# Student Council Elections AY 2026-27

The five candidate CSV files can now be imported into **one election**. Each
file is one office. Its final `Level N` field splits candidates into separate
ballot groups. For example, `AVP Sports` creates `AVP Sports — Level 4`,
`AVP Sports — Level 5`, and `AVP Sports — Level 6`. Every voter makes one
choice (or chooses **Not interested**) in each group.

## Setup before the first vote

1. Sign in at `/admin.html` and import `voters.csv` under Roster upload.
2. Under **Positions → Import candidates by level**, enter each office name and
   select its matching file:
   - `President` → `candidates-1-president.csv`
   - `VP General` → `candidates-2-vp-general.csv`
   - `VP Women Empowerment` → `candidates-3-vp-women-empowerment.csv`
   - `AVP Culture` → `candidates-4-avp-culture.csv`
   - `AVP Sports` → `candidates-5-avp-sports.csv`
3. Review the position and candidate lists. Import every file before the first
   ballot is cast. A repeated import of an existing position and level is
   rejected to prevent duplicate candidates.
4. Set the election title and optional final deadline. The deadline is a hard
   close, including when voting is on hold.

## Run voting in batches

Use **Hold voting** in the admin console between batches or overnight. Voters
cannot request or verify a code or cast a ballot while held. Their recorded
votes and unused vote sessions remain intact. Use **Resume voting** for the
next batch. Hold and resume can be repeated until the final close.

After the last batch, use **Close voting**, verify and approve the result, then
download the election backup and results CSV. Closing is final; Resume cannot
reopen a closed election. A reset clears ballots and is for a new election or
practice run, not for the pause between batches.
