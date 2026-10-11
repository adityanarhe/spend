# Spend

A personal expense tracker that answers two questions: **where is my money going, and how much?**

It runs on an iPhone as a home-screen web app, logs payments automatically from bank and Swiggy emails, and keeps every rupee of data **on the phone**: no account, no server, no third party.

**Live app:** https://adityanarhe.github.io/spend/ (empty until you connect your own Gmail; your data never leaves your device)

---

## Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Privacy model](#privacy-model)
- [Supported sources](#supported-sources)
- [Set up your own copy](#set-up-your-own-copy)
- [Using the app](#using-the-app)
- [Project structure](#project-structure)
- [Design decisions](#design-decisions)
- [Problems we hit and how we solved them](#problems-we-hit-and-how-we-solved-them)
- [Testing](#testing)
- [Limitations](#limitations)
- [Roadmap](#roadmap)

---

## Why this exists

I pay through an HDFC credit card, an HDFC RuPay credit card on UPI, and UPI from my savings account, and most food and groceries come through Swiggy and Instamart. Existing trackers either wanted me to type every expense, were full budgeting suites I'd never use, or sent my bank data through someone else's servers.

The goals were:

- **See spending, not manage budgets.** Totals, categories, days. Nothing else.
- **Automatic.** No manual logging for normal payments.
- **Local.** Financial data stays on my device.
- **Simple and readable.** iOS look and feel, easy to scan.

Inspired by [ExpenseOwl](https://github.com/Tanq16/ExpenseOwl)'s "tracking, not budgeting" philosophy (and its CSV format). Heavier tools like [Actual](https://github.com/actualbudget/actual) and [Firefly III](https://github.com/firefly-iii/firefly-iii) were ruled out for being budgeting suites; Android SMS trackers like [PennyWise](https://github.com/sarim2000/pennywiseai-tracker) confirmed that pattern-based parsing of Indian bank messages works without AI, but they can't run on iPhone.

## What it does

| Screen | What you see |
|---|---|
| **Today** | Spent today, this week, this month. A 7-day chart (bars with amounts, or a pie by category). Recent payments grouped by day. |
| **Month** | Month total vs the same point last month, spend by category, a daily chart with the daily average, split by payment method, top places. Tap the title to jump to any month. |
| **Import** | Sync Gmail, import statements or SMS, review anything the app couldn't read, settings, backup/export. |

- **Tap a bar** to see that day's payments. **Tap a payment** to see details, change its category, or see the Swiggy items behind it.
- **Change a category once** and the app remembers it for that merchant.
- **Swiggy orders are linked to their payments,** so a ₹562 UPI payment shows the eight grocery items it paid for.
- **Nothing is dropped silently.** Messages that look like payments but don't match a known format land in *Unrecognised*, where you can fix them by hand.
- Light and dark mode, all text at WCAG AA contrast (4.5:1 or better).

## How it works

```
 Gmail (HDFC alerts, Swiggy/Instamart orders)        Statements / SMS file
          │  read-only, straight to the phone                │  you pick the file
          ▼                                                  ▼
   ┌────────────────────────── parsers.js ─────────────────────────────┐
   │  fixed text patterns (regex) per message template → payment/order │
   └───────────────────────────────────────────────────────────────────┘
          │                                   │ no pattern matched
          ▼                                   ▼
   import.js: merge duplicates,         "Unrecognised" list → fix by hand
   link Swiggy orders to payments       → "Fixes to review" log
          │
          ▼
   IndexedDB on the phone  ──►  app.js renders Today / Month / Import
```

1. **Automatic:** each sync reads new HDFC transaction-alert emails and Swiggy/Instamart order emails from Gmail (first sync: last 90 days).
2. **Monthly check (optional):** importing a card statement (PDF) or bank statement (CSV) fills any gaps; a statement row *confirms* the alert you already have instead of adding a duplicate.
3. **Fallback (optional):** an iOS Shortcut can save bank SMS texts to a file the app imports.

**No AI, no training.** Bank and Swiggy emails are generated from fixed templates: the wording is identical every time and only the numbers change. One regex per template pulls out amount, merchant, date and reference. It's exact, instant, free and runs entirely on the phone.

## Privacy model

| Data | Where it lives |
|---|---|
| Payments, orders, categories, settings | **IndexedDB on your phone only** |
| Gmail access pass | `sessionStorage` (gone when the app closes); valid 1 hour, read-only scope |
| App code | GitHub Pages; it serves files only and never sees any data |
| Real email/statement samples used for development | Local `samples/` folder, git-ignored, never committed |

- The only network calls with your data go **from your phone to Google** (to read your own Gmail).
- The Google Client ID is not a secret and is stored on the device, not in the code.
- **Back up regularly** (Import → Export backup): deleting the home-screen app deletes its data.

## Supported sources

| Source | Format | Status |
|---|---|---|
| HDFC credit card alert email | `Rs. … has been debited from your HDFC Bank Credit Card ending … towards MERCHANT on 08 Oct, 2026 at …` | ✅ confirmed |
| HDFC UPI alert email (savings) | `Rs.… is debited from your account ending … towards VPA x@y (Name) on 08-10-26` | ✅ confirmed |
| HDFC RuPay credit card on UPI | `Rs.… has been debited from your RuPay Credit Card (ending …) Paid to x@y Date: 09-10-26` | ✅ confirmed |
| Swiggy food order email (`noreply@swiggy.in`) | table of items, `Order Total: ₹ …`, `Order placed at: …` | ✅ confirmed |
| Instamart order email (`noreply@instamart.in`) | `2 x Item ₹…` lines, `Grand Total ₹…` | ✅ confirmed |
| HDFC credit card statement | PDF (password protected) | ⏳ draft pattern |
| HDFC bank statement | NetBanking "Delimited" CSV | ⏳ draft pattern |
| HDFC SMS (via iOS Shortcut) | text file | ⏳ draft pattern |

Gmail senders searched: `alerts@hdfcbank.net`, `alerts@hdfcbank.bank.in`, `noreply@swiggy.in`, `no-reply@swiggy.in`, `noreply@instamart.in`.

Categories: Food, Groceries, Shopping, Transport, Bills, Entertainment, Health, Travel, People, Other, plus **Card bill** and **Self transfer**, which are excluded from totals (paying your card bill from the bank would otherwise count the same spend twice).

## Set up your own copy

You need a GitHub account and a Google account. No build tools, no npm.

### 1. Host the app

Fork or copy this repo, then enable **GitHub Pages** (Settings → Pages → branch `main`, folder `/`). Your app will be at `https://<you>.github.io/spend/`.

### 2. Create a Google OAuth Client ID (one time, ~10 minutes)

In [Google Cloud Console](https://console.cloud.google.com), signed in with the Gmail account that receives your bank alerts:

1. **Create a project** (e.g. `Spend`).
2. **APIs & Services → Library → Gmail API → Enable.**
3. **Google Auth Platform → Get started:** app name, support email, Audience **External**.
4. **Audience → Test users:** add your own Gmail. The app stays in *testing* mode, so only you can sign in.
5. **Data Access → Add scopes:** `https://www.googleapis.com/auth/gmail.readonly`.
6. **Clients → Create client → Web application**, and fill in **both** lists:

   | Field | Value | Rule |
   |---|---|---|
   | Authorized JavaScript origins | `https://<you>.github.io` and `http://localhost:5173` | domain only: no path, no trailing `/` |
   | Authorized redirect URIs | `https://<you>.github.io/spend/` and `http://localhost:5173/` | full address, trailing `/` included, must match exactly |

7. Copy the Client ID (ends in `.apps.googleusercontent.com`).

### 3. Install on iPhone

1. Open your app URL in **Safari** → Share → **Add to Home Screen**. Always open it from the home-screen icon (it has separate storage from Safari tabs).
2. **Import → Google Client ID** → paste.
3. **Sync Gmail** → sign in → "Google hasn't verified this app" → **Continue** (expected: you are the app's only user).

### Run locally

```bash
python -m http.server 5173
```

Then open http://localhost:5173 (and http://localhost:5173/tests.html for the parser tests).

## Using the app

- **Daily:** open Spend → **Sync**. If you signed in within the last hour and haven't closed the app, it syncs straight away; otherwise Google's page appears briefly (no password if you're still signed in to Google) and sends you back.
- **Unrecognised:** fix each one (amount, merchant, date, payment method, category) or mark it "not a payment". Every fix is logged under **Fixes to review**; **Export fixes** produces a file you can use to add a new pattern. After a pattern update, the app re-checks Unrecognised on every open and clears whatever now parses.
- **Statements:** Import → Import a file → card statement PDF (asks for the password) or bank statement CSV.
- **SMS fallback (optional):** Shortcuts → Automation → **Message contains "HDFC"** → Run Immediately → **Append to Text File** (`spend-sms.txt`, text = Shortcut Input + a `---` line). Import that file whenever you like; re-importing is safe.
- **Settings:** month start day (e.g. salary day), backup/restore, CSV export (ExpenseOwl-compatible columns `name,category,amount,date`).

## Project structure

Plain HTML, CSS and JavaScript. No framework, no build step, ~1,500 lines in total.

```
index.html     App shell: three tabs, bottom sheet, toast
style.css      iOS look: system colours/type, grouped lists, light + dark, charts
db.js          IndexedDB wrapper (payments, orders, settings) + backup export/restore
parsers.js     The text patterns: HDFC alerts, SMS, Swiggy/Instamart, statements; categories
import.js      Duplicate merging, Swiggy order ↔ payment linking, file import, re-checking Unrecognised
gmail.js       Gmail sign-in (redirect) and sync
app.js         Screens, charts, sheets, fix flow, events
sw.js          Offline support (always revalidates so updates arrive on next open)
manifest.json  Home-screen install metadata
tests.html     Open in a browser: runs every parser against example messages
icons/         App icons
```

External code: only **pdf.js** (from cdnjs, loaded the first time you import a PDF statement) and Google's OAuth endpoint.

## Design decisions

| Decision | Why |
|---|---|
| **Installable web app, not a native iOS app** | Native needs a Mac and an Apple developer account. A home-screen web app looks native enough and is built from Windows. |
| **Gmail as the automation backbone** | iOS doesn't let apps read SMS, and web apps can't run in the background. HDFC emails every card and UPI payment, so reading Gmail gives a near-real-time daily view. |
| **Regex, not AI** | Bank emails are fixed templates. Patterns are exact, instant, free, testable, and keep everything on the phone. |
| **No framework, no build** | Fewer moving parts. The whole app is readable in an afternoon. |
| **IndexedDB on the device** | Keeps financial data local. The trade-off (data tied to one device) is covered by backup export. |
| **No Account Aggregator** | India's AA framework could fetch bank data automatically, but through a licensed third party. |
| **Orders never count toward totals** | Totals come only from bank and card payments; Swiggy orders only add item detail to a linked payment. A cancelled order can't inflate spending. |

## Problems we hit and how we solved them

Real issues found while building and using the app, in roughly the order they came up.

| Problem | Cause | Fix |
|---|---|---|
| **No Swiggy API** | Swiggy has no public API for customers. | Parse Swiggy/Instamart order emails for items; take amounts from bank alerts. |
| **Draft patterns didn't match real emails** | Formats guessed from memory differed from HDFC's actual wording ("towards VPA", "account ending", "reference no.:"). | Every pattern rebuilt from real (redacted) samples and locked in with a test. |
| **Instamart orders never synced** | Instamart mails from `noreply@instamart.in`, not a Swiggy domain. | Added the sender; sender check accepts either brand. |
| **Dish names ending in numbers** ("Paneer 65", "Chicken 555") | Read as quantities. | The *last* number before ₹ is the quantity; `-Variant ₹…` sub-lines are skipped (items then sum exactly to the bill). |
| **Late-night food orders landed on the wrong day** | Email arrives after midnight. | Use "Order placed at" from the email body. |
| **Some UPI alerts unrecognised although the wording matched** | HTML→text conversion leaves invisible characters (zero-width, non-breaking spaces) and odd spacing. | Normalise text before matching. |
| **Old unrecognised messages stayed stuck after a fix** | Patterns only ran at sync time. | Unrecognised is re-checked with the current patterns on every app open. |
| **RuPay credit card payments missing** | A third alert wording ("Paid to … Date: …") with only a UPI ID, no name. | New pattern, own payment method; readable names derived from UPI IDs (`uberindia…rzp@…` → `UBERINDIASYSTEM`). |
| **RuPay and bank UPI payments could merge** | Duplicate check treated every non-Visa/Master payment as "the bank account". | Only savings-account UPI/bank debits share an account; each card is separate. |
| **Payment counted twice** | Paying the card bill from the bank looks like spending. | "Card bill" category, excluded from totals. |
| **"Failed to open popup window" on iPhone** | Safari blocks popups not opened instantly by a tap, and home-screen apps can't reliably receive popup results. | Switched Google sign-in to a full-page redirect; the token returns in the URL fragment (never sent to a server), is checked against a one-time `state` value, and is wiped from the address bar. |
| **`redirect_uri_mismatch` / "URIs must not contain a path"** | Google keeps *origins* (domain only) and *redirect URIs* (full address) in two separate lists. | Documented in setup: origins without a path, redirect URI with `/spend/`. |
| **Category dropdown unreadable in dark mode** (white on white) | The browser draws native dropdowns itself and wasn't told the page had a dark theme. | `color-scheme` on the page, explicit option colours; contrast audit of every text style in both themes, using Apple's higher-contrast colours where the standard ones fell below 4.5:1. |
| **Charts showed nothing useful** | No amounts; one ₹14k day flattened every other day to a stub; grey bars nearly invisible; not tappable. | Amount labels, daily-average line, "broken" bar for outliers (real amount still labelled), tap a bar to see that day's payments. |
| **Navigating months meant repeated tapping** | Previous/Next buttons only. | The month title is a picker listing every month with its total. |
| **Updates took a while to reach the phone** | The browser's cache could serve old files for minutes. | Service worker always revalidates; a guard tolerates one mixed old/new load right after an update. |
| **Keeping real data out of a public repo** | Test fixtures and code comments are easy places for real details to slip in. | Real samples live in a git-ignored folder; tests use anonymised equivalents with the same format; every change is scanned for known real values before it is committed, and the commit stops if any are found. |

## Testing

Open **`tests.html`** in a browser (locally or on the live site). It runs every parser against example messages, written to match real formats but with anonymised details, and shows pass/fail. Currently **25 checks**, covering:

- Each confirmed email format, including variants (redacted digits, missing names, HTML-converted text with invisible characters)
- Swiggy/Instamart items, quantities and totals (items must sum to the bill)
- Statement rows, card-bill exclusion, refunds
- Date formats, UPI-ID names, category rules

When a new message format turns up, add a case to `tests.html` first, then make it pass.

## Limitations

- **iPhone can't read SMS in the background;** the SMS fallback needs a one-tap import.
- **Data is per device and per browser.** The home-screen app and a Safari tab have separate storage; use backup/restore to move data.
- **Gmail sign-in lasts an hour,** and Google may ask for re-approval about weekly while the OAuth app is in testing mode.
- **Statement and SMS patterns are drafts** until confirmed against real samples.
- **HDFC and Swiggy only.** Other banks need their own patterns (one regex + one test each).

## Roadmap

- Confirm the credit card statement, bank statement and SMS patterns against real samples
- Patterns from the exported fix log as new formats appear
- Optional: other banks or apps, if needed

---

Personal project, built for one user's real spending. Feel free to adapt it for your own bank's formats.
