# Viewership of shared links

The operator wants to know who opens shared links: how many people, which pages and
strategies they read, from which browsers, devices, countries and referring sites.
The data has to be searchable and tied to the links themselves.

## Where the counting happens

Counting is built into the collector instead of delegated to Cloudflare Web Analytics or a
separate analytics service:

- **Cloudflare** counts per hostname and path. It cannot tell which strategy a token belongs
  to, cannot be searched, and needs the DNS moved.
- **A separate service** (Plausible, Umami) is another container to run, and the deployment
  is kept to one image.
- **In the collector**, each view joins to its share row and strategy, and the data stays in
  the same SQLite file under the same admin session.

Cloudflare remains recommended in front for DDoS protection. When it is there, its
`CF-IPCountry` header supplies the visitor's country.

## Collection

- **Beacon:** each shared page reports itself once as it opens, with `POST /public/:token/view`
  carrying `{page, strategy?, referrer?}` through `navigator.sendBeacon`.
- **Crawlers:** clients that do not run JavaScript never report, and user agents that look
  automated are dropped.
- **Validation:** the page must be one the link's kind renders. The strategy is kept only if
  the link covers it. The referrer must be a bare host other than the dashboard's own.
  Country must be two letters, and language a single well-formed tag.
- **Limits:** the body is capped at 1 KB and schema-validated. The beacon shares the public
  per-IP request budget.

## Privacy

- **Visitor identity:** no IP address, cookie or raw user agent is stored. The visitor id is a
  SHA-256 of the IP and user agent under a salt created per UTC day. Earlier salts are
  deleted, so ids cannot be linked across days. Unique visitors are counted within a day and
  summed across days.
- **Agent details:** only coarse browser, system and device class are kept.

## Bounds

- **Repeats:** the same visitor opening the same page within 30 minutes counts once.
- **Daily cap:** at most 20,000 stored views per shared subject per UTC day.
- **Retention:** views are kept 90 days and pruned by the retention job.

## Operator views

- **Viewership tab:** under Audience. It has range and link filters, and totals for views,
  unique visitors, links and countries. It shows views and unique visitors per UTC day, and
  breakdowns by link, page, strategy, browser, system, device, country, referrer and
  language. A searchable list shows recent views.
- **Share controls:** each shows its link's view count for the retention window.
