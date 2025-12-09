// Freelancer.com Jobs Scraper - Robust Anti-Bot Implementation
// Multi-strategy: API-first → JSON-LD → HTML fallback
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset, RequestQueue } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '',
            category = '',
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 20,
            collectDetails = true,
            startUrl,
            startUrls,
            url,
            proxyConfiguration,
            minBudget,
            maxBudget,
            jobType = 'all',
            sortBy = 'relevance',
            requestDelay = 1500,
            useApiFirst = true,
            dedupe = true
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 20;
        const REQUEST_DELAY = Math.max(500, Math.min(10000, +requestDelay || 1500));

        // ============ ANTI-BOT: Header Generator ============
        const headerGenerator = new HeaderGenerator({
            browsers: [
                { name: 'chrome', minVersion: 110 },
                { name: 'firefox', minVersion: 115 },
                { name: 'edge', minVersion: 110 }
            ],
            devices: ['desktop'],
            operatingSystems: ['windows', 'macos', 'linux']
        });

        const generateHeaders = (referer = 'https://www.freelancer.com/jobs') => {
            const headers = headerGenerator.getHeaders();
            return {
                ...headers,
                'Referer': referer,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
            };
        };

        const generateApiHeaders = (referer = 'https://www.freelancer.com/jobs') => {
            const headers = headerGenerator.getHeaders();
            return {
                ...headers,
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Referer': referer,
                'X-Requested-With': 'XMLHttpRequest',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin'
            };
        };

        // ============ UTILITY FUNCTIONS ============
        const toAbs = (href, base = 'https://www.freelancer.com') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const randomDelay = (baseMs = REQUEST_DELAY) =>
            new Promise(resolve => setTimeout(resolve, baseMs + Math.random() * 1500));

        const buildStartUrl = (kw, cat) => {
            let base = 'https://www.freelancer.com/jobs';
            if (cat) {
                base = `${base}/${encodeURIComponent(String(cat).toLowerCase().trim().replace(/\s+/g, '-'))}`;
            }
            return base;
        };

        // ============ PROXY SETUP ============
        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
            : undefined;

        const getProxyUrl = async () => {
            if (!proxyConf) return undefined;
            try {
                const proxyInfo = await proxyConf.newUrl();
                return proxyInfo || undefined;
            } catch {
                return undefined;
            }
        };

        // ============ JSON-LD EXTRACTION ============
        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const raw = $(scripts[i]).html();
                    if (!raw) continue;
                    const parsed = JSON.parse(raw);
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            return {
                                title: e.title || e.name || '',
                                company: e.hiringOrganization?.name || '',
                                date_posted: e.datePosted || '',
                                description_html: e.description || '',
                                location: e.jobLocation?.address?.addressLocality ||
                                    e.jobLocation?.address?.addressRegion ||
                                    e.jobLocation?.name || '',
                                salary: e.baseSalary?.value?.value ||
                                    String(e.baseSalary?.value || '') ||
                                    (e.baseSalary?.minValue && e.baseSalary?.maxValue
                                        ? `${e.baseSalary.minValue}-${e.baseSalary.maxValue}`
                                        : ''),
                                currency: e.baseSalary?.currency || 'USD',
                                employment_type: e.employmentType || ''
                            };
                        }
                    }
                } catch { /* ignore */ }
            }
            return null;
        }

        // ============ HTML EXTRACTION - LISTING PAGE ============
        function findJobLinksFromListing($, baseUrl) {
            const links = new Set();
            $('a[href*="/projects/"]').each((_, el) => {
                const href = $(el).attr('href');
                if (href && !href.includes('/contests/') && !href.includes('/repost')) {
                    const absUrl = toAbs(href, baseUrl);
                    if (absUrl && absUrl.includes('/projects/')) {
                        links.add(absUrl);
                    }
                }
            });
            return [...links];
        }

        function findNextPageUrl(currentUrl, currentPage) {
            try {
                const urlObj = new URL(currentUrl);
                const pathParts = urlObj.pathname.split('/').filter(Boolean);

                // Remove page number if present
                const lastPart = pathParts[pathParts.length - 1];
                if (/^\d+$/.test(lastPart)) {
                    pathParts.pop();
                }

                // Add next page number
                pathParts.push(String(currentPage + 1));
                urlObj.pathname = '/' + pathParts.join('/');
                return urlObj.href;
            } catch {
                return null;
            }
        }

        // ============ HTML EXTRACTION - DETAIL PAGE ============
        function extractFromHtml($, url) {
            // Title
            const title =
                $('h1.PageProjectViewLogout-title').text().trim() ||
                $('h1[class*="project-title"]').text().trim() ||
                $('h1.ng-binding').first().text().trim() ||
                $('[class*="ProjectTitle"]').text().trim() ||
                $('h1').first().text().trim() ||
                '';

            // Budget
            const budgetSelectors = [
                'p.PageProjectViewLogout-budget',
                '[class*="ProjectBudget"]',
                '[class*="Budget"]',
                '.Budget',
                'span:contains("USD")',
                'span:contains("$")'
            ];
            let budget = '';
            for (const sel of budgetSelectors) {
                const el = $(sel).first();
                if (el.length) {
                    budget = el.text().trim().replace(/\s+/g, ' ');
                    if (budget) break;
                }
            }

            // Description
            const descSelectors = [
                'div.PageProjectViewLogout-detail',
                '.project-details',
                'article.description',
                '[class*="ProjectDescription"]',
                '.ProjectDescription',
                'div[class*="description"]'
            ];
            let description_html = '';
            let description_text = '';
            for (const sel of descSelectors) {
                const el = $(sel).first();
                if (el.length && el.html()) {
                    description_html = el.html().trim();
                    description_text = el.text().replace(/\s+/g, ' ').trim();
                    if (description_text.length > 50) break;
                }
            }

            // Skills
            const skills = [];
            $('a[href*="/jobs/"]').each((_, el) => {
                const skillText = $(el).text().trim();
                if (skillText && skillText.length > 1 && skillText.length < 50 && !skillText.includes('Browse')) {
                    skills.push(skillText);
                }
            });

            // Date posted
            const timeEl = $('time[datetime]').first();
            let date_posted = timeEl.attr('datetime') || timeEl.text().trim() || '';
            if (!date_posted) {
                const postedText = $('*:contains("Posted")').filter((_, el) =>
                    $(el).text().includes('ago') || $(el).text().includes('Posted')
                ).first().text();
                const match = postedText.match(/(Posted\s+)?(\d+\s+\w+\s+ago|less than.+ago)/i);
                if (match) date_posted = match[0];
            }

            // Project ID
            let project_id = '';
            const idMatch = url.match(/\/projects\/[^\/]+\/[^\/]+-(\d+)/) ||
                url.match(/-(\d+)$/);
            if (idMatch) {
                project_id = idMatch[1];
            } else {
                const pageText = $.text();
                const projIdMatch = pageText.match(/Project ID[:\s]*(\d+)/i);
                if (projIdMatch) project_id = projIdMatch[1];
            }

            // Company/Client
            let company = '';
            const clientSelectors = [
                '[class*="AboutBuyer"] a',
                '[class*="client"] a',
                '[class*="employer"] a',
                '.ClientInfo a'
            ];
            for (const sel of clientSelectors) {
                const el = $(sel).first();
                if (el.length) {
                    company = el.text().trim();
                    if (company) break;
                }
            }

            // Job Type
            const pageText = $.text().toLowerCase();
            let job_type = '';
            if (pageText.includes('hourly')) job_type = 'Hourly';
            else if (pageText.includes('fixed')) job_type = 'Fixed Price';

            // Bids count
            let bids_count = '';
            const bidsMatch = $.text().match(/(\d+)\s*bids?/i);
            if (bidsMatch) bids_count = bidsMatch[1];

            return {
                title,
                company,
                budget,
                description_html,
                description_text,
                skills: [...new Set(skills)],
                date_posted,
                project_id,
                job_type,
                bids_count
            };
        }

        // ============ API STRATEGY ============
        async function fetchJobsFromApi(pageNum, kw, cat) {
            if (!useApiFirst) return null;

            try {
                const proxyUrl = await getProxyUrl();

                // Try the search API endpoint
                let apiUrl = `https://www.freelancer.com/api/projects/0.1/projects/active`;
                const params = new URLSearchParams({
                    compact: 'true',
                    limit: '50',
                    offset: String((pageNum - 1) * 50),
                    full_description: 'true',
                    job_details: 'true',
                    user_details: 'true'
                });

                if (kw) params.append('query', kw);
                if (cat) params.append('jobs[]', cat);

                apiUrl = `${apiUrl}?${params.toString()}`;

                const response = await gotScraping({
                    url: apiUrl,
                    headers: generateApiHeaders(),
                    proxyUrl,
                    responseType: 'json',
                    timeout: { request: 30000 },
                    retry: { limit: 2 }
                });

                if (response.body?.result?.projects) {
                    log.info(`API: Fetched ${response.body.result.projects.length} jobs from page ${pageNum}`);
                    return response.body.result.projects.map(p => ({
                        title: p.title || '',
                        company: p.owner?.username || '',
                        budget: p.budget ? `${p.currency?.code || 'USD'} ${p.budget.minimum || ''}-${p.budget.maximum || ''}` : '',
                        description_html: p.description || '',
                        description_text: p.description ? cleanText(p.description) : '',
                        skills: p.jobs?.map(j => j.name) || [],
                        date_posted: p.time_submitted ? new Date(p.time_submitted * 1000).toISOString() : '',
                        project_id: String(p.id || ''),
                        job_type: p.type === 'hourly' ? 'Hourly' : 'Fixed Price',
                        bids_count: String(p.bid_stats?.bid_count || ''),
                        location: p.owner?.location?.country?.name || '',
                        url: `https://www.freelancer.com/projects/${p.seo_url || p.id}`,
                        _source: 'freelancer.com'
                    }));
                }
            } catch (err) {
                log.warning(`API fetch failed for page ${pageNum}: ${err.message}`);
            }
            return null;
        }

        // ============ INITIAL URLS ============
        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) {
            for (const u of startUrls) {
                if (typeof u === 'string') initial.push(u);
                else if (u?.url) initial.push(u.url);
            }
        }
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, category));

        log.info(`Starting scrape with ${initial.length} URLs`);

        // ============ STATE ============
        let saved = 0;
        const seenUrls = new Set();

        // ============ CRAWLER ============
        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 5,
            useSessionPool: true,
            persistCookiesPerSession: true,
            sessionPoolOptions: {
                maxPoolSize: 50,
                sessionOptions: {
                    maxUsageCount: 50
                }
            },
            maxConcurrency: 5,
            requestHandlerTimeoutSecs: 90,
            navigationTimeoutSecs: 60,

            async preNavigationHooks({ request }) {
                // Set stealth headers
                request.headers = generateHeaders(request.userData?.referer || 'https://www.freelancer.com/jobs');
                // Random delay
                await randomDelay();
            },

            async requestHandler({ request, $, enqueueLinks, crawler: crawlerInstance }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (saved >= RESULTS_WANTED) {
                    log.info(`Reached target of ${RESULTS_WANTED} results. Stopping.`);
                    return;
                }

                // ============ LIST PAGE ============
                if (label === 'LIST') {
                    log.info(`Processing LIST page ${pageNo}: ${request.url}`);

                    // Try API first for listing data
                    const apiJobs = await fetchJobsFromApi(pageNo, keyword, category);

                    if (apiJobs && apiJobs.length > 0) {
                        // Got data from API
                        for (const job of apiJobs) {
                            if (saved >= RESULTS_WANTED) break;
                            if (dedupe && seenUrls.has(job.url)) continue;

                            seenUrls.add(job.url);
                            await Dataset.pushData({
                                ...job,
                                category: category || '',
                                _source: 'freelancer.com'
                            });
                            saved++;
                        }
                        log.info(`Saved ${saved} jobs so far (from API)`);
                    } else {
                        // Fallback to HTML parsing
                        const links = findJobLinksFromListing($, request.url);
                        log.info(`HTML: Found ${links.length} job links on page ${pageNo}`);

                        if (collectDetails) {
                            const remaining = RESULTS_WANTED - saved;
                            const toEnqueue = [];
                            for (const link of links) {
                                if (toEnqueue.length >= remaining) break;
                                if (dedupe && seenUrls.has(link)) continue;
                                seenUrls.add(link);
                                toEnqueue.push(link);
                            }
                            if (toEnqueue.length) {
                                await enqueueLinks({
                                    urls: toEnqueue,
                                    userData: { label: 'DETAIL', referer: request.url }
                                });
                            }
                        } else {
                            // Just save URLs
                            for (const link of links) {
                                if (saved >= RESULTS_WANTED) break;
                                if (dedupe && seenUrls.has(link)) continue;
                                seenUrls.add(link);
                                await Dataset.pushData({
                                    url: link,
                                    _source: 'freelancer.com'
                                });
                                saved++;
                            }
                        }
                    }

                    // Pagination
                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const nextUrl = findNextPageUrl(request.url, pageNo);
                        if (nextUrl) {
                            await enqueueLinks({
                                urls: [nextUrl],
                                userData: { label: 'LIST', pageNo: pageNo + 1, referer: request.url }
                            });
                        }
                    }
                    return;
                }

                // ============ DETAIL PAGE ============
                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;

                    try {
                        // Try JSON-LD first
                        const jsonLd = extractFromJsonLd($);
                        // Then HTML
                        const htmlData = extractFromHtml($, request.url);

                        // Merge data (JSON-LD takes priority if present)
                        const merged = {
                            title: jsonLd?.title || htmlData.title || '',
                            company: jsonLd?.company || htmlData.company || '',
                            category: category || '',
                            location: jsonLd?.location || htmlData.location || '',
                            salary: jsonLd?.salary || htmlData.budget || '',
                            job_type: jsonLd?.employment_type || htmlData.job_type || '',
                            skills: htmlData.skills || [],
                            date_posted: jsonLd?.date_posted || htmlData.date_posted || '',
                            description_html: jsonLd?.description_html || htmlData.description_html || '',
                            description_text: htmlData.description_text || cleanText(jsonLd?.description_html || ''),
                            project_id: htmlData.project_id || '',
                            bids_count: htmlData.bids_count || '',
                            url: request.url,
                            _source: 'freelancer.com'
                        };

                        // Validate minimum data
                        if (merged.title || merged.description_text) {
                            await Dataset.pushData(merged);
                            saved++;
                            log.info(`Saved job ${saved}: ${merged.title.substring(0, 50)}...`);
                        } else {
                            log.warning(`Skipped job (no data): ${request.url}`);
                        }
                    } catch (err) {
                        log.error(`Detail page failed: ${request.url} - ${err.message}`);
                    }
                }
            },

            async failedRequestHandler({ request }, error) {
                log.error(`Request failed: ${request.url} - ${error.message}`);
            }
        });

        // Run crawler
        await crawler.run(initial.map(u => ({
            url: u,
            userData: { label: 'LIST', pageNo: 1 }
        })));

        log.info(`Scraping complete. Total saved: ${saved} jobs`);

    } finally {
        await Actor.exit();
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
