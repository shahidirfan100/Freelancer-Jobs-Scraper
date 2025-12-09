// Freelancer.com jobs scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '', category = '', results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999, collectDetails = true, startUrl, startUrls, url, proxyConfiguration,
            minBudget, maxBudget, jobType = 'all', sortBy = 'relevance'
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

        const toAbs = (href, base = 'https://www.freelancer.com') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildStartUrl = (kw, cat) => {
            let url = 'https://www.freelancer.com/jobs';
            if (cat) {
                url = `${url}/${encodeURIComponent(String(cat).toLowerCase().trim())}`;
            }
            return url;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, category));

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            return {
                                title: e.title || e.name || null,
                                company: e.hiringOrganization?.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location: (e.jobLocation && e.jobLocation.address && (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion)) || null,
                                salary: e.baseSalary?.value || e.baseSalary?.minValue || null,
                            };
                        }
                    }
                } catch (e) { /* ignore parsing errors */ }
            }
            return null;
        }

        function findJobLinks($, base) {
            const links = new Set();
            $('a[href*="/projects/"]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                const abs = toAbs(href, base);
                if (abs && abs.includes('/projects/')) links.add(abs);
            });
            return [...links];
        }

        function findNextPage($, base, currentPage) {
            // Freelancer.com uses pagination in URL params
            const nextPage = currentPage + 1;
            const nextButton = $('a[rel="next"]');
            if (nextButton.length) {
                return toAbs(nextButton.attr('href'), base);
            }
            return null;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            maxConcurrency: 10,
            requestHandlerTimeoutSecs: 60,
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (label === 'LIST') {
                    const links = findJobLinks($, request.url);
                    crawlerLog.info(`LIST ${request.url} -> found ${links.length} links`);

                    if (collectDetails) {
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = links.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length) await enqueueLinks({ urls: toEnqueue, userData: { label: 'DETAIL' } });
                    } else {
                        const remaining = RESULTS_WANTED - saved;
                        const toPush = links.slice(0, Math.max(0, remaining));
                        if (toPush.length) { await Dataset.pushData(toPush.map(u => ({ url: u, _source: 'freelancer.com' }))); saved += toPush.length; }
                    }

                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const next = findNextPage($, request.url, pageNo);
                        if (next) await enqueueLinks({ urls: [next], userData: { label: 'LIST', pageNo: pageNo + 1 } });
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;
                    try {
                        const json = extractFromJsonLd($);
                        const data = json || {};

                        // Extract title from multiple possible selectors
                        if (!data.title) {
                            data.title = $('h1[class*="title"]').first().text().trim() ||
                                $('h1').first().text().trim() ||
                                $('.PageProjectViewLogout-title').text().trim() || null;
                        }

                        // Extract budget/salary info (enhanced)
                        if (!data.salary) {
                            // Try multiple selectors for budget
                            const budgetSelectors = [
                                'p.PageProjectViewLogout-budget',
                                '.Budget',
                                '[class*="ProjectBudget"]',
                                '[class*="budget"]',
                                '[class*="price"]'
                            ];
                            let budgetText = '';
                            for (const sel of budgetSelectors) {
                                const el = $(sel).first();
                                if (el.length) {
                                    budgetText = el.text().trim();
                                    if (budgetText) break;
                                }
                            }
                            // Also look for currency patterns in page
                            if (!budgetText) {
                                const pageHtml = $.html();
                                const currencyMatch = pageHtml.match(/[\$€£]\s*\d+[\d,\.]*\s*[-–]?\s*[\$€£]?\s*\d*[\d,\.]*/i) ||
                                    pageHtml.match(/\d+[\d,\.]*\s*[-–]\s*\d+[\d,\.]*\s*(USD|EUR|GBP|AUD|CAD)/i);
                                if (currencyMatch) budgetText = currencyMatch[0].trim();
                            }
                            data.salary = budgetText || null;
                        }

                        // Extract job type (Fixed/Hourly) - enhanced detection
                        const pageText = $.text();
                        const pageTextLower = pageText.toLowerCase();
                        let detectedJobType = null;

                        // Check for explicit type indicators
                        if (pageTextLower.includes('paid on delivery') || pageTextLower.includes('fixed price') ||
                            pageTextLower.includes('fixed-price') || pageTextLower.includes('project budget')) {
                            detectedJobType = 'Fixed Price';
                        } else if (pageTextLower.includes('hourly') || pageTextLower.includes('per hour') ||
                            pageTextLower.includes('/hr') || pageTextLower.includes('/ hr')) {
                            detectedJobType = 'Hourly';
                        } else {
                            // Try element-based detection
                            const typeEl = $('[class*="type"]').filter((_, el) => {
                                const t = $(el).text().toLowerCase();
                                return t.includes('fixed') || t.includes('hourly');
                            }).first().text().trim().toLowerCase();
                            if (typeEl.includes('hourly')) detectedJobType = 'Hourly';
                            else if (typeEl.includes('fixed')) detectedJobType = 'Fixed Price';
                        }
                        data.job_type = detectedJobType;

                        // Extract skills/tags
                        const skills = [];
                        $('a[href*="/jobs/"]').each((_, el) => {
                            const skillText = $(el).text().trim();
                            if (skillText && skillText.length < 50) skills.push(skillText);
                        });
                        data.skills = skills.length ? skills : null;

                        // Extract description
                        if (!data.description_html) {
                            const desc = $('[class*="description"]').first();
                            data.description_html = desc && desc.length ? String(desc.html()).trim() :
                                $('article').first().html() ||
                                $('.PageProjectViewLogout-detail').html() || null;
                        }
                        data.description_text = data.description_html ? cleanText(data.description_html) : null;

                        // Extract location
                        if (!data.location) {
                            data.location = $('[class*="location"]').first().text().trim() ||
                                'Remote' || null;
                        }

                        // Extract date posted (enhanced)
                        if (!data.date_posted) {
                            // Try time element first
                            const timeEl = $('time[datetime]').first();
                            let postedDate = timeEl.attr('datetime') || timeEl.text().trim();

                            // Look for relative time patterns
                            if (!postedDate) {
                                const timePatterns = [
                                    /Posted\s+(less than\s+)?\d+\s+\w+\s+ago/i,
                                    /\d+\s+(minute|hour|day|week|month)s?\s+ago/i,
                                    /less than\s+\d+\s+\w+\s+ago/i,
                                    /just now/i,
                                    /today/i
                                ];
                                const text = $.text();
                                for (const pattern of timePatterns) {
                                    const match = text.match(pattern);
                                    if (match) {
                                        postedDate = match[0].trim();
                                        break;
                                    }
                                }
                            }

                            // Look for date in specific elements
                            if (!postedDate) {
                                const dateEl = $('[class*="posted"], [class*="date"], [class*="time"]').first();
                                if (dateEl.length) postedDate = dateEl.text().trim();
                            }

                            data.date_posted = postedDate || null;
                        }

                        // Extract client/employer info
                        const clientName = $('[class*="client"]').find('a').first().text().trim() ||
                            $('[class*="employer"]').first().text().trim();
                        data.company = clientName || 'Freelancer Client';

                        // Extract category from URL if not provided in input
                        let extractedCategory = category;
                        if (!extractedCategory) {
                            try {
                                const urlObj = new URL(request.url);
                                const pathParts = urlObj.pathname.split('/').filter(Boolean);
                                // Pattern: /projects/{category}/{slug}
                                if (pathParts[0] === 'projects' && pathParts.length >= 2) {
                                    extractedCategory = pathParts[1]
                                        .replace(/-/g, ' ')
                                        .replace(/\b\w/g, c => c.toUpperCase());
                                }
                            } catch { /* ignore */ }
                        }

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            category: extractedCategory || null,
                            location: data.location || null,
                            salary: data.salary || null,
                            job_type: data.job_type || null,
                            skills: data.skills || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                            _source: 'freelancer.com'
                        };

                        await Dataset.pushData(item);
                        saved++;
                    } catch (err) { crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`); }
                }
            }
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
