// Freelancer.com Jobs Scraper - Stealthy CheerioCrawler Implementation
// Uses JSON-LD + HTML parsing with anti-bot measures
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
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
                'Upgrade-Insecure-Requests': '1'
            };
        };

        // ============ UTILITY FUNCTIONS ============
        const toAbs = (href, base = 'https://www.freelancer.com') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        // Clean HTML - extract text content only, preserve meaningful whitespace
        const cleanHtml = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe, svg, link, meta').remove();

            // Replace block elements with newlines for readability
            $('br, p, div, li, tr, h1, h2, h3, h4, h5, h6').each((_, el) => {
                $(el).append('\n');
            });

            return $.root().text()
                .replace(/\r\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .replace(/[ \t]+/g, ' ')
                .replace(/\n /g, '\n')
                .replace(/ \n/g, '\n')
                .trim();
        };

        const randomDelay = (baseMs = REQUEST_DELAY) =>
            new Promise(resolve => setTimeout(resolve, baseMs + Math.random() * 1000));

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
                                employment_type: e.employmentType || ''
                            };
                        }
                    }
                } catch { /* ignore */ }
            }
            return null;
        }

        // ============ HTML EXTRACTION - LISTING PAGE ============
        function findJobLinks($, baseUrl) {
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

        function findNextPage($, baseUrl, currentPage) {
            // Try rel="next" first
            const nextButton = $('a[rel="next"]');
            if (nextButton.length) {
                return toAbs(nextButton.attr('href'), baseUrl);
            }

            // Fallback: construct URL-based pagination
            try {
                const urlObj = new URL(baseUrl);
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

        // ============ EXTRACT CATEGORY FROM URL ============
        function extractCategoryFromUrl(url) {
            try {
                const urlObj = new URL(url);
                const pathParts = urlObj.pathname.split('/').filter(Boolean);
                // Pattern: /projects/{category}/{slug}
                if (pathParts[0] === 'projects' && pathParts.length >= 2) {
                    return pathParts[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                }
                // Pattern: /jobs/{category}
                if (pathParts[0] === 'jobs' && pathParts.length >= 2 && !/^\d+$/.test(pathParts[1])) {
                    return pathParts[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                }
            } catch { /* ignore */ }
            return '';
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

        log.info(`Starting scrape with ${initial.length} URLs, target: ${RESULTS_WANTED} jobs`);

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
            maxConcurrency: 8,
            requestHandlerTimeoutSecs: 90,
            navigationTimeoutSecs: 60,

            async preNavigationHooks({ request }) {
                request.headers = generateHeaders(request.userData?.referer || 'https://www.freelancer.com/jobs');
                await randomDelay();
            },

            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (saved >= RESULTS_WANTED) {
                    crawlerLog.info(`Reached target of ${RESULTS_WANTED} results. Stopping.`);
                    return;
                }

                // ============ LIST PAGE ============
                if (label === 'LIST') {
                    const links = findJobLinks($, request.url);
                    crawlerLog.info(`LIST page ${pageNo}: ${request.url} -> found ${links.length} job links`);

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
                            crawlerLog.info(`Enqueued ${toEnqueue.length} detail pages`);
                        }
                    } else {
                        // Just save URLs
                        for (const link of links) {
                            if (saved >= RESULTS_WANTED) break;
                            if (dedupe && seenUrls.has(link)) continue;
                            seenUrls.add(link);
                            await Dataset.pushData({
                                url: link,
                                category: category || extractCategoryFromUrl(link),
                                _source: 'freelancer.com'
                            });
                            saved++;
                        }
                    }

                    // Pagination
                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const nextUrl = findNextPage($, request.url, pageNo);
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
                        const data = jsonLd || {};

                        // === TITLE ===
                        if (!data.title) {
                            data.title = $('h1.PageProjectViewLogout-title').text().trim() ||
                                $('h1[class*="title"]').first().text().trim() ||
                                $('h1').first().text().trim() ||
                                '';
                        }

                        // === BUDGET/SALARY ===
                        if (!data.salary) {
                            const budgetText = $('p.PageProjectViewLogout-budget').text().trim() ||
                                $('[class*="Budget"]').first().text().trim() ||
                                $('[class*="budget"]').first().text().trim() ||
                                $('[class*="price"]').first().text().trim();
                            data.salary = budgetText || '';
                        }

                        // === JOB TYPE (Fixed/Hourly) ===
                        const pageText = $.text().toLowerCase();
                        if (pageText.includes('paid on delivery') || pageText.includes('fixed price') || pageText.includes('fixed-price')) {
                            data.job_type = 'Fixed Price';
                        } else if (pageText.includes('hourly') || pageText.includes('per hour') || pageText.includes('/hr')) {
                            data.job_type = 'Hourly';
                        } else {
                            // Check specific elements
                            const typeEl = $('[class*="type"]').filter((_, el) => {
                                const text = $(el).text().toLowerCase();
                                return text.includes('fixed') || text.includes('hourly');
                            }).first().text().trim();

                            if (typeEl.toLowerCase().includes('hourly')) {
                                data.job_type = 'Hourly';
                            } else if (typeEl.toLowerCase().includes('fixed')) {
                                data.job_type = 'Fixed Price';
                            } else {
                                data.job_type = '';
                            }
                        }

                        // === SKILLS ===
                        const skills = [];
                        $('a[href*="/jobs/"]').each((_, el) => {
                            const skillText = $(el).text().trim();
                            if (skillText && skillText.length > 1 && skillText.length < 50 &&
                                !skillText.toLowerCase().includes('browse') &&
                                !skillText.toLowerCase().includes('all jobs')) {
                                skills.push(skillText);
                            }
                        });
                        data.skills = [...new Set(skills)];

                        // === DESCRIPTION (Clean HTML to text) ===
                        if (!data.description_html) {
                            const descEl = $('div.PageProjectViewLogout-detail').first();
                            if (descEl.length) {
                                data.description_html = descEl.html()?.trim() || '';
                            } else {
                                const altDesc = $('[class*="description"]').first();
                                data.description_html = altDesc.html()?.trim() ||
                                    $('article').first().html()?.trim() || '';
                            }
                        }
                        // Clean description - remove HTML tags, keep text
                        data.description_text = cleanHtml(data.description_html);

                        // === LOCATION ===
                        if (!data.location) {
                            data.location = $('[class*="location"]').first().text().trim() || '';
                        }

                        // === DATE POSTED ===
                        if (!data.date_posted) {
                            const timeEl = $('time[datetime]').first();
                            data.date_posted = timeEl.attr('datetime') || timeEl.text().trim() || '';

                            if (!data.date_posted) {
                                // Look for "Posted X ago" pattern
                                const postedMatch = $.text().match(/Posted\s+(less than\s+)?\d+\s+\w+\s+ago/i);
                                if (postedMatch) {
                                    data.date_posted = postedMatch[0];
                                }
                            }
                        }

                        // === CLIENT/COMPANY ===
                        if (!data.company) {
                            const clientName = $('[class*="client"] a').first().text().trim() ||
                                $('[class*="employer"] a').first().text().trim() ||
                                $('[class*="AboutBuyer"] a').first().text().trim();
                            data.company = clientName || '';
                        }

                        // === CATEGORY (from URL or input) ===
                        const extractedCategory = category || extractCategoryFromUrl(request.url);

                        // === PROJECT ID ===
                        let project_id = '';
                        const idMatch = request.url.match(/-(\d+)$/) ||
                            $.text().match(/Project ID[:\s]*(\d+)/i);
                        if (idMatch) project_id = idMatch[1];

                        // === BIDS COUNT ===
                        let bids_count = '';
                        const bidsMatch = $.text().match(/(\d+)\s*bids?/i);
                        if (bidsMatch) bids_count = bidsMatch[1];

                        // Build final item
                        const item = {
                            title: data.title || '',
                            company: data.company || '',
                            category: extractedCategory,
                            location: data.location || '',
                            salary: data.salary || '',
                            job_type: data.job_type || '',
                            skills: data.skills.length ? data.skills : [],
                            date_posted: data.date_posted || '',
                            description_html: data.description_html || '',
                            description_text: data.description_text || '',
                            project_id: project_id,
                            bids_count: bids_count,
                            url: request.url,
                            _source: 'freelancer.com'
                        };

                        // Validate minimum data
                        if (item.title || item.description_text) {
                            await Dataset.pushData(item);
                            saved++;
                            crawlerLog.info(`Saved job ${saved}/${RESULTS_WANTED}: ${item.title.substring(0, 50)}...`);
                        } else {
                            crawlerLog.warning(`Skipped job (no data): ${request.url}`);
                        }
                    } catch (err) {
                        crawlerLog.error(`Detail page failed: ${request.url} - ${err.message}`);
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
