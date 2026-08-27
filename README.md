# InstaChat server (v2 — accounts, admin, spam & profanity filtering)

A small self-hosted chat server: real accounts, an admin role, named chats,
automatic spam blocking, and a basic profanity filter. No external
database — everything is stored in JSON files on disk.

## What's new in this version

- **Accounts** — sign up with a username + password. Passwords are hashed
  (never stored in plain text) using Node's built-in `crypto.scrypt`.
- **Per-chat admin role** — whoever *creates* a room is automatically that
  room's admin (not a server-wide role tied to your account). Room admins
  can:
  - Promote other people currently in that chat to admin (the shield icon
    next to the chat name → "Manage this chat")
  - Rename that chat (pencil icon)
  - Delete any message in that chat (hover a bubble to see the × button)
  Admin status is scoped per room — being admin of one chat doesn't make
  you admin of another one someone else created.
- **Chat naming** — whoever creates a room can give it a friendly name
  instead of just the room code.
- **Spam blocking** — the server automatically blocks a message if a user
  sends more than 5 messages in 4 seconds, or repeats the same message 3
  times in a row. Repeat offenders get a short (8s) or longer (30s)
  cooldown where their messages are silently dropped, with a warning shown
  only to them.
- **Profanity filter** — messages containing a blocked word are rejected
  outright (not sent to anyone) with a private notice to the sender. The
  word list lives near the top of `server.js` as `BANNED_WORDS` — edit
  that array to add or remove words.
- **InstaAI** — a built-in AI chat, pinned at the top of everyone's sidebar.
  It's private per person (not a shared room others can join) and talks to
  Anthropic's Claude API.

## Setting up InstaAI (optional but needed for it to actually respond)

InstaAI needs an Anthropic API key to work. Without one, it'll still show
up in the sidebar but will just reply saying it isn't set up yet.

1. Get an API key from https://console.anthropic.com (Anthropic's
   developer console — separate from a normal claude.ai account, and
   billed separately based on usage).
2. On Render: open your service → **Environment** tab → **Add Environment
   Variable** → key `ANTHROPIC_API_KEY`, value: your key → Save.
3. Render will automatically redeploy with the key available. Open
   InstaAI in the sidebar and say hi.

Each person's InstaAI conversation is private to them and lives only in
that connection's memory — it resets if they refresh the page or the
server restarts, the same as regular chat history.

## Deploy it (Render.com, free)

Same as before:

1. Put this folder in a GitHub repo — make sure `server.js` and
   `package.json` end up at the **root** of the repo, not nested inside
   another folder (unzip locally first — don't drag the raw `.zip` into
   GitHub).
2. On Render: **New +** → **Web Service** → connect the repo.
3. Build Command: `npm install` · Start Command: `npm start` · Free plan.
4. Open the URL Render gives you and sign up. Create a chat to become its
   admin, or join one someone else made.

## Important: accounts & chat names are saved to disk, with one caveat

Signed-up accounts and chat names are written to a `data/` folder next to
`server.js` so they survive normal restarts. However, **Render's free tier
doesn't guarantee that disk survives a redeploy** (pushing new code, or
Render migrating your instance to new hardware) — it's not a *persistent*
disk unless you pay for one. For a casual chat app between friends this is
usually fine (your account will very likely still be there), but don't
treat it as a permanent database for anything important. If you want it
rock-solid, Render's paid plans offer an actual Persistent Disk add-on you
can attach at `/opt/render/project/src/data`.

Message *history* (the chat scrollback) was never persisted even in v1 —
that still resets whenever the server restarts. Only accounts and chat
names/creators are saved now.

## Running it locally to test

```
npm install
npm start
```

Open `http://localhost:3000` in two browser tabs (or incognito + normal
window, so they don't share the same login) to try signing up as two
different users.
