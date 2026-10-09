# FullEnrich Exporter (FE Export) – Chrome extension to export FullEnrich people search results to CSV

**Export FullEnrich search results to CSV with full profiles: job history with dates and role descriptions, company data, skills, languages and education. Works from a list of LinkedIn URLs (HeyReach, Sales Navigator or any CSV). Read only, runs in your own browser, never spends enrichment credits.**

FullEnrich's web app shows complete candidate and lead profiles in its People search for free, but has no bulk export and no way to look up a list of LinkedIn profile URLs. FE Export fills that gap for recruiters, sourcers and SDRs: load a CSV, let the extension search each person, match the right row by LinkedIn URL, and download one clean CSV you can push into your ATS, CRM, n8n, Make or Zapier workflow.

![FE Export popup](icons/icon128.png)

## Features

- **CSV in, CSV out.** Load a HeyReach, LinkedIn Sales Navigator or custom CSV with a `Profile URL` column. Get back every original column plus the FullEnrich profile fields.
- **Full profiles, not just the table row.** Current title and company, complete employment history with start and end dates, role descriptions, company domain, size, industry, headquarters, skills, languages with proficiency, education.
- **Exact matching by LinkedIn URL.** The person is found by name and company, then confirmed by the LinkedIn profile link on the row. Wrong-person matches do not happen.
- **Batch search.** Up to 40 people per search (names and companies combined), then a one-by-one pass for anything missed. A 450-person list takes minutes.
- **Smart name fallbacks.** Strips titles and suffixes ("Dr.", "PhD", "MBA") and derives a name from the LinkedIn slug when the CSV name does not match.
- **Resume-safe.** Progress is saved after every person. Close the popup, come back, pause, resume.
- **Zero credits.** Only table rows, filter chips and panels are touched. Enrich, Find phone and Find email are never clicked.
- **Export the current search too.** Any FullEnrich People search, every page, to CSV.
- **Debug file.** One click gives a log and the raw search responses, so problems can be fixed without guesswork.
- **Apple-style popup.** Light and dark mode, keyboard focus, reduced-motion aware.

## Install (Chrome, Edge, Brave)

1. Download or clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the folder.
3. Open https://app.fullenrich.com/app/search/people and reload the tab once (the extension hooks the page at load time).

No build step, no dependencies, no account, no server. Everything runs locally.

## Use: list of LinkedIn URLs to full profiles

1. On **Search → People**, click the FE Export icon.
2. **Choose CSV** and pick your file. It needs a column with LinkedIn profile links (`Profile URL`, `LinkedIn URL`, `LinkedIn Profile URL` or similar). Name and company columns improve matching.
3. **Start.** The popup shows found, not found, errors and time left. You can close it; the run continues in the tab.
4. **Export results.** The file is named `<your list> - fullenrich - YYYY-MM-DD.csv`.

People FullEnrich does not have come back as `not_found` with their original columns intact, so the same file can still feed your next step.

## Use: export the current search

Run any People search, open the popup, choose whether to walk every page, click **Export this search**.

## Output columns

Original columns first, then:

| Column | Content |
|---|---|
| `fe_title`, `fe_company`, `fe_company_domain`, `fe_industry`, `fe_headcount` | current role and company |
| `fe_city`, `fe_country` | location (ISO country code) |
| `fe_years_in_role` | years since the current role started |
| `fe_history` | numbered employment history: title, company (industry, size, country), dates, seniority, description |
| `fe_skills`, `fe_languages`, `fe_education` | comma or pipe separated lists |
| `FE status`, `FE note` | `done`, `not_found` or `error`, with the reason |
| `Matched by` | `linkedin_url`, `batch`, `name_company` or `search_response` |
| `Profile JSON` | the complete profile as JSON, same shape as the FullEnrich API returns, ready for automation |

## What is not included

- The person's About / summary text (FullEnrich's search response does not carry it).
- Emails and phone numbers (those are FullEnrich's paid enrichment and are never triggered).
- People missing from FullEnrich's database.

## How it works

FullEnrich's People search is a Svelte app. When a filter chip is added, the page requests `SearchContacts` and receives the full profile of every row in the result (gRPC-web, protobuf). FE Export runs a small script in the page at load time that decodes that response and keeps the profiles keyed by LinkedIn slug. The content script drives the filter panel (Person Name and Company Name chips), waits for the table, matches rows to your CSV and assembles the CSV. The side panel is read only as a fallback. The protobuf layout is documented at the top of `main-world.js`. There is no backend and nothing leaves your browser.

## Privacy

FE Export does not collect, store remotely or transmit any data. All processing happens in your browser; files are written to your Downloads folder by you. The extension requests access to `app.fullenrich.com` only.

## FAQ

**Does this cost FullEnrich credits?** No. Viewing search results and the side panel is free in FullEnrich. Credits are only used by Enrich / Find actions, which the extension never clicks.

**Can I import LinkedIn URLs into FullEnrich directly?** Not through FullEnrich's UI. FE Export searches by name and company and confirms the row by its LinkedIn link.

**Why are some people not found?** Either FullEnrich does not have them, or the name in your CSV differs too much. Check `FE note` in the export; the debug file shows the rows that were on screen.

**Will it break when FullEnrich changes its UI?** Possibly. Selectors avoid generated class names where they can, and the debug file is designed to make a fix quick. Open an issue with the debug file attached.

## Keywords

FullEnrich export, FullEnrich CSV export, FullEnrich bulk export, export FullEnrich search results, FullEnrich Chrome extension, FullEnrich scraper, LinkedIn URL to profile data, enrich LinkedIn URLs free, HeyReach CSV enrichment, Sales Navigator list enrichment, recruiter sourcing tools, candidate sourcing automation, B2B lead data export, n8n FullEnrich, FullEnrich alternative to API credits.

## Author

Built by **Asad Ullah**, EmergeTech. Email: asadbahi5033@gmail.com · GitHub: [asadullah231](https://github.com/asadullah231)

I build recruiting and sales automations with n8n and Claude. If you need this adapted to another data tool or wired into your ATS, get in touch.

## License

MIT. See [LICENSE](LICENSE). Not affiliated with FullEnrich.
