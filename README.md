# Freelancer.com Jobs Scraper

Extract freelance job opportunities from Freelancer.com with precision and speed. This powerful data extraction tool helps freelancers, agencies, and market researchers gather comprehensive job listings including project details, budgets, required skills, and client information.

## What Does This Scraper Do?

This automation tool systematically collects job postings from Freelancer.com across any category or search criteria. Whether you're tracking SEO projects, web development gigs, or graphic design opportunities, this scraper delivers structured, ready-to-use data.

### Key Capabilities

- **Multi-Category Search** - Target specific job categories (SEO, web development, design, writing, etc.)
- **Smart Data Extraction** - Automatically extracts titles, budgets, job types, skills, descriptions, and posting dates
- **Flexible Filtering** - Filter by budget range, job type (fixed/hourly), and custom keywords
- **Automatic Pagination** - Seamlessly navigates through multiple pages to collect large datasets
- **Detailed Scraping Mode** - Optional deep-dive into individual job pages for complete project descriptions
- **JSON-LD Support** - Prioritizes structured data extraction for accuracy and speed
- **Fallback HTML Parsing** - Ensures data capture even when structured data is unavailable

## Use Cases

**For Freelancers:**
- Monitor job opportunities in your niche automatically
- Analyze market rates and common project requirements
- Identify trending skills and technologies in demand

**For Agencies & Recruiters:**
- Build prospect lists of active project posters
- Track competitor activity and market trends
- Generate leads from businesses posting freelance work

**For Market Researchers:**
- Analyze freelance market trends across industries
- Study pricing patterns and budget distributions
- Identify emerging skill demands and hiring patterns

## Input Configuration

Configure your scraping job with these parameters:

### Basic Search Options

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `category` | String | Job category slug (e.g., 'seo', 'web-development') | `seo` |
| `keyword` | String | Search keyword or skill filter | `seo` |
| `startUrl` | String | Custom Freelancer.com jobs URL (overrides category/keyword) | - |

### Filtering Options

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `jobType` | Select | Filter by 'all', 'fixed', or 'hourly' projects | `all` |
| `minBudget` | Integer | Minimum project budget in USD | - |
| `maxBudget` | Integer | Maximum project budget in USD | - |
| `sortBy` | Select | Sort by 'relevance', 'newest', or 'budget' | `relevance` |

### Scraping Control

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `collectDetails` | Boolean | Extract full job descriptions and details | `true` |
| `results_wanted` | Integer | Maximum number of jobs to collect (1-1000) | `100` |
| `max_pages` | Integer | Safety limit on pages to crawl (1-100) | `20` |

### Advanced Settings

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `proxyConfiguration` | Object | Proxy settings (residential recommended) | Apify Residential |
| `dedupe` | Boolean | Remove duplicate job listings | `true` |
| `cookies` | String | Custom cookie header (optional) | - |
| `cookiesJson` | String | JSON-formatted cookies array (optional) | - |

## Output Data Format

Each extracted job listing contains:

```json
{
  "title": "SEO Expert Needed for E-commerce Website",
  "company": "Tech Solutions Inc.",
  "category": "seo",
  "location": "Remote",
  "salary": "$250-$750 USD",
  "job_type": "Fixed Price",
  "skills": ["SEO", "Link Building", "Keyword Research", "Google Analytics"],
  "date_posted": "2025-12-09",
  "description_html": "<p>Full HTML description...</p>",
  "description_text": "Plain text version of the job description...",
  "url": "https://www.freelancer.com/projects/seo/...",
  "_source": "freelancer.com"
}
```

### Data Fields Explained

- **title** - Job/project title
- **company** - Client or employer name
- **category** - Job category classification
- **location** - Geographic location (often "Remote" for Freelancer.com)
- **salary** - Budget or salary range
- **job_type** - Fixed price or hourly project
- **skills** - Array of required skills and technologies
- **date_posted** - When the job was posted
- **description_html** - Full job description with HTML formatting
- **description_text** - Plain text description without HTML tags
- **url** - Direct link to the job posting

## How to Use

### Quick Start Example

1. **Choose Your Category**
   - Browse [Freelancer.com/jobs](https://www.freelancer.com/jobs) to find category slugs
   - Common categories: `seo`, `web-development`, `graphic-design`, `writing`, `data-entry`

2. **Set Your Parameters**
   ```json
   {
     "category": "seo",
     "results_wanted": 50,
     "jobType": "fixed",
     "minBudget": 100,
     "collectDetails": true
   }
   ```

3. **Run and Export**
   - Start the actor
   - Download results in JSON, CSV, or Excel format
   - Integrate with your workflow via API

### Advanced Usage

**Custom URL Scraping:**
```json
{
  "startUrl": "https://www.freelancer.com/jobs/seo?sort=newest",
  "results_wanted": 100,
  "collectDetails": true
}
```

**Budget-Filtered Search:**
```json
{
  "category": "web-development",
  "minBudget": 500,
  "maxBudget": 2000,
  "jobType": "fixed",
  "results_wanted": 200
}
```

## Performance & Limits

- **Speed:** Processes 50-100 jobs in 2-5 minutes (with detail scraping)
- **Maximum Results:** Up to 1000 jobs per run
- **Recommended:** Use residential proxies for best reliability
- **Rate Limiting:** Built-in delays prevent blocking

## Best Practices

✅ **Do:**
- Use residential proxies for consistent results
- Enable `collectDetails` for comprehensive data
- Set reasonable `results_wanted` limits (50-200 for most use cases)
- Filter by budget and job type to get relevant results

❌ **Avoid:**
- Excessive scraping without proxies
- Collecting more data than needed (slows performance)
- Running multiple instances on the same category simultaneously

## Technical Details

### Architecture
- **Framework:** Apify SDK + Crawlee
- **HTTP Client:** got-scraping with header rotation
- **Parser:** Cheerio for efficient HTML parsing
- **Data Priority:** JSON-LD → HTML selectors → fallback parsing

### Proxy Requirements
- **Recommended:** Apify Residential Proxy
- **Minimum:** Datacenter proxies may work but increase block risk
- **Configuration:** Automatically included in default settings

## Troubleshooting

**Issue:** No results returned
- **Solution:** Verify category slug is correct, try a different keyword, or use a custom `startUrl`

**Issue:** Incomplete data extraction
- **Solution:** Enable `collectDetails` to visit individual job pages

**Issue:** Scraper getting blocked
- **Solution:** Ensure residential proxies are enabled in `proxyConfiguration`

**Issue:** Duplicate results
- **Solution:** Enable `dedupe` option (enabled by default)

## Data Export Options

Export your scraped data in multiple formats:
- **JSON** - For API integration and processing
- **CSV** - For spreadsheet analysis
- **Excel** - For business reporting
- **HTML** - For quick viewing
- **RSS** - For feed integration

## Integration & API

Access your data programmatically:

```javascript
// JavaScript example
const { ApifyClient } = require('apify-client');

const client = new ApifyClient({ token: 'YOUR_API_TOKEN' });
const run = await client.actor('YOUR_ACTOR_ID').call({
  category: 'seo',
  results_wanted: 100
});

const dataset = await client.dataset(run.defaultDatasetId).listItems();
console.log(dataset.items);
```

## Support & Updates

This scraper is actively maintained and regularly updated to adapt to website changes. Data extraction reliability is continuously monitored and optimized.

**Need Help?** Check the input parameters carefully and ensure your configuration matches your data collection goals.

## Legal & Ethical Use

This tool is designed for legitimate business intelligence, market research, and personal job searching purposes. Users are responsible for:
- Complying with Freelancer.com's Terms of Service
- Respecting rate limits and website resources
- Using collected data ethically and legally
- Following data protection regulations (GDPR, CCPA, etc.)

## Version History

**v1.0.0** - Initial release
- Multi-category job scraping
- JSON-LD and HTML parsing
- Budget and job type filtering
- Automatic pagination
- Detailed job data extraction

---

**Ready to extract valuable freelance market data?** Configure your search parameters and start scraping Freelancer.com jobs efficiently.
