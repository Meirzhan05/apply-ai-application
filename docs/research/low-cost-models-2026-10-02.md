# Low-cost model routing for Apply

**Checked:** 2026-10-02  
**Scope:** OpenAI API token prices and relevant capabilities, plus Browser Use Cloud browser-infrastructure fees for an illustrative $5/month student budget. All estimates below are arithmetic from published rates and assumed token/session counts. They are not measured usage or model-quality results.

## Recommendation

Use `gpt-6-luna` as the default model for matching, grounding/checking, drafting, essay work, and browser field mapping, as requested. OpenAI describes Luna as its most efficient model for focused, high-volume tasks; the model supports Structured Outputs and function calling, and its Responses API supports web search, file search, and computer use. Its standard short-context rate is $0.10 per million input tokens and $0.50 per million output tokens. This is a price-based routing choice, not a quality-validated result: no representative live quality evaluation was available for this research. Keep existing fact checks, review controls, and application approvals in place while quality is unverified. [GPT-6 Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna), [OpenAI pricing](https://developers.openai.com/api/docs/pricing)

`gpt-6.1-sol` is a potential explicit, bounded per-request upgrade if a user later asks for one; this note does not imply that upgrade controls exist in the product. Sol costs $2/$10 per million input/output tokens and OpenAI describes it as near-Astra performance at a lower cost. At the same assumed token counts below, a Sol writer/essay request adds about $0.039 over Luna. Do not automatically escalate failed or uncertain Luna requests to Sol or Astra. The default Luna route was requested despite the lack of a representative quality evaluation, so its quality on Apply’s student materials remains unvalidated. [GPT-6.1 Sol model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [OpenAI model guidance](https://developers.openai.com/api/docs/models)

Treat `gpt-5-nano` as an optional later candidate for low-consequence classification or extraction only. It is cheaper at $0.05/$0.40 per million tokens and supports structured output, function calling, and web search, but OpenAI positions it for summarization and classification and recommends its newer Luna tier for most new cost-sensitive workloads. `gpt-4.1-nano` is another narrow candidate for short structured mapping: it costs $0.10/$0.40, supports structured output and function calling, and is described as good at instruction following and tool calling, but its listed tools do not include web search or computer use. Neither candidate has been evaluated on Apply’s inputs. [GPT-5 nano model page](https://developers.openai.com/api/docs/models/gpt-5-nano), [GPT-4.1 nano model page](https://developers.openai.com/api/docs/models/gpt-4.1-nano), [OpenAI pricing](https://developers.openai.com/api/docs/pricing)

Several “mini/nano” labels are not cheaper than Luna under current standard rates: GPT-5.4 mini is $0.75/$4.50, GPT-5.4 nano $0.20/$1.25, GPT-5 mini $0.25/$2.00, and GPT-4o mini $0.15/$0.60 per million input/output tokens. Those models may have other task-specific tradeoffs, but price alone does not support switching from Luna. [OpenAI pricing](https://developers.openai.com/api/docs/pricing)

## Current standard short-context rates

Rates are USD per million tokens. These are Standard rates for prompts of 272K input tokens or less, before any hosted-tool fees. The OpenAI pricing page shows higher input/output rates above 272K for the latest models. Cached-input rates are lower, but the examples below conservatively assume uncached input. [OpenAI pricing](https://developers.openai.com/api/docs/pricing)

| Model | Input | Output | Relevance |
| --- | ---: | ---: | --- |
| `gpt-6-luna` | $0.10 | $0.50 | Recommended low-cost default candidate |
| `gpt-5-nano` | $0.05 | $0.40 | Cheaper; consider only for classification/extraction after evaluation |
| `gpt-4.1-nano` | $0.10 | $0.40 | Slightly cheaper output for simple structured mappings; no listed web-search/computer-use tools |
| `gpt-6-sol` | $2.00 | $10.00 | Current Sol price in the app’s route summary |
| `gpt-6.1-sol` | $2.00 | $10.00 | Potential per-request upgrade; not implied to be implemented |
| `gpt-6-astra` | $10.00 | $50.00 | Reserve for a user-requested exceptional case; not a default |
| `gpt-5.4-mini` | $0.75 | $4.50 | More expensive than Luna |
| `gpt-5.4-nano` | $0.20 | $1.25 | More expensive than Luna |

Luna is 20 times cheaper than Sol per input and output token and 100 times cheaper than Astra at these rates. GPT-5 nano is cheaper than Luna per token, but OpenAI’s current model guidance recommends Luna for cost-sensitive, high-volume workloads; raw price alone does not demonstrate that nano will maintain the quality needed for student application materials. [OpenAI model guidance](https://developers.openai.com/api/docs/models), [GPT-5 nano model page](https://developers.openai.com/api/docs/models/gpt-5-nano)

## Capability and reasoning constraints

For strict JSON and function calling, Luna is the best-supported low-cost default among the models compared here: its model page lists Structured Outputs, function calling, web search, and computer use. The current implementation audit describes the browser mapping path as structured DOM/text input; it does not use the model’s native computer-use tool, so computer-use support is not required for that route. GPT-5 nano lists Structured Outputs, function calling, and web search, but not computer use. GPT-4.1 nano lists Structured Outputs and function calling, but its supported-tools list does not include web search or computer use; those omissions do not by themselves disqualify it from a narrow DOM/text mapping evaluation. [GPT-6 Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-5 nano model page](https://developers.openai.com/api/docs/models/gpt-5-nano), [GPT-4.1 nano model page](https://developers.openai.com/api/docs/models/gpt-4.1-nano)

Use the Responses API when the model needs OpenAI tool calling. GPT-6 Luna supports function calling in Chat Completions only when reasoning effort is `none`; GPT-6.1 Sol supports tool calling through Responses, while its Chat Completions endpoint does not support tool calling. Confirm the endpoint and effort setting before routing tool-using work to an upgrade. [GPT-6 Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-6.1 Sol model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol)

Reasoning tokens are billed at the selected model’s output rate. OpenAI says lower reasoning effort generally favors fewer reasoning tokens and lower latency, while higher effort can increase quality and cost; actual usage depends on the prompt and task. For bounded extraction/classification, consider `none` or `low`; avoid high effort as an implicit retry path. Set an output-token ceiling and track actual usage. [Reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)

## Illustrative per-call model costs

Assumptions below are total billed tokens per model request: output counts include any hidden reasoning tokens. Actual token usage varies. Arithmetic uses uncached Standard rates and excludes tool fees.

| Operation | Assumed input/output | Current route in task context | At current route | At Luna | Difference from Luna to current route |
| --- | ---: | --- | ---: | ---: | ---: |
| Resume writer | 8,000 / 2,500 | Sol | $0.04100 | $0.00205 | $0.03895 |
| Essay draft | 8,000 / 2,500 | Sol | $0.04100 | $0.00205 | $0.03895 |
| Checker / grounding | 8,000 / 1,000 | Luna | $0.00130 | $0.00130 | — |
| Matching | 3,000 / 500 | Luna | $0.00055 | $0.00055 | — |
| Browser-field mapping | 5,000 / 700 | Astra | $0.08500 | $0.00085 | $0.08415 |

At these sizes, using Sol for a selected writer/essay call adds about four cents; using Astra instead of Luna for a mapping call adds about eight cents. These estimates show cost only; they do not measure whether a model gets an individual application task right.

## Illustrative monthly mix and Browser Use charges

Example volume: **20 resume drafts, 10 essay drafts, 30 checker/grounding calls (one per draft), 100 matches, and 20 browser-field mappings**. Assume every listed operation is one request at the token sizes above. This excludes additional essay grounding calls, retries, or other model requests. At the summarized current routing (30 writer/essay calls on Sol, checks and matching on Luna, mapping on Astra), model tokens cost about **$3.024/month**. Routing all these requests to Luna costs about **$0.1725/month**. That difference is a routing illustration, not a measured quality result.

The repository’s [integration status](../INTEGRATIONS.md#current-browser-provider) identifies Browser Use Cloud as the production provider. The current implementation audit confirms it uses the v4 **browser infrastructure API** and attaches Playwright over CDP, rather than Browser Use’s hosted agent-task API. So the relevant provider charges are browser time and traffic, not Browser Use’s separate 20% hosted-agent model-token surcharge. [Browser Use pricing](https://browser-use.com/pricing), [Browser Use Playwright browser docs](https://browser-use.com/playwright)

Browser Use lists browser infrastructure at $0.02 per browser-hour, billed by the minute with a one-minute minimum; managed residential proxies are $5/GB and are on by default. It says direct/own-proxy traffic is $0.20/GB, with the proxy provider potentially charging separately. Twenty 10-minute sessions would cost roughly **$0.067** in browser time. If those sessions used **0.25 GB** of residential-proxy traffic, that adds **$1.25**; one full GB adds **$5**. [Browser Use pricing](https://browser-use.com/pricing), [Browser Use Playwright browser docs](https://browser-use.com/playwright)

Under the 0.25 GB example, the current model routing plus browser fees totals about **$4.34**; all-Luna routing plus the same provider usage totals about **$1.49**. At 1 GB of proxy traffic, Browser Use’s proxy charge alone reaches the entire $5 budget, before OpenAI tokens or browser time. These are assumptions for planning: real traffic, session lengths, retries, and token counts must be measured. Browser Use offers pay-as-you-go credits with a $5 minimum top-up and no subscription; eligible new signups may receive a one-time $15 credit. That minimum is a purchase threshold, not a recurring $5 monthly plan, and the one-time credit should not be treated as a continuing subsidy. [Browser Use pricing](https://browser-use.com/pricing)

OpenAI-hosted web search, if used, is a separate line item: $10 per 1,000 search calls plus search-result content tokens billed at the model’s input rate. This does not replace Browser Use session/proxy charges and is not included in the estimates above. [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Web search guide](https://developers.openai.com/api/docs/guides/tools-web-search)

## Budget controls to consider

The current repository budget audit found `MONTHLY_SPEND_LIMIT_USD` defaults to $500/month and enforces a global, month-keyed reservation ceiling. It accumulates projected reservations rather than settled provider invoices; it does not include other activity in the OpenAI or Browser Use accounts or fixed service charges. This app-side reservation control is therefore not a precise billing guarantee and is not a per-student $5 cap. [Repository budget and lifecycle notes](../INTEGRATIONS.md#budget-and-lifecycle)

- Apply Luna as the requested default while keeping existing fact checks, review controls, and application approvals in place. Evaluate representative resume, essay, ranking, and browser-field cases before claiming quality is preserved; do not present the price arithmetic as quality evidence.
- If a per-request upgrade is later added, let the student explicitly select Sol for a particular draft and show the estimated increment from measured usage. Do not silently retry on a more expensive model.
- Track OpenAI input, cached-input, output, and reasoning tokens separately from Browser Use browser minutes and proxy megabytes. The browser proxy meter is likely the larger swing factor in the $5 plan.
- To make the $5 monthly target enforceable, add a student-scoped budget based on reconciled OpenAI and Browser Use usage, with separate meters and a stop/ask threshold. Keep per-request output limits; Browser Use’s $5 minimum top-up and OpenAI token usage are separate billing mechanisms.

No live paid inference was run for this research. Task context reports that the production OpenAI API currently returns `429 credit_balance_exhausted`, so the estimates must not be read as a live usage or quality verification.
