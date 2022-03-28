import puppeteer, {HTTPResponse} from "puppeteer";
import _ from "highland";
import url from "url";
import path from "path";
import fs from "fs";
import { createTracker, augmentTimeoutError } from "./tracker";
import {ICrawlParams, IEnableLoggingOptions, IReactSnapRunLogs} from "./model";
const mapStackTrace = require("sourcemapped-stacktrace-node").default;

const errorToString = jsHandle =>
  jsHandle.executionContext().evaluate(e => e.toString(), jsHandle);

const objectToJson = jsHandle => jsHandle.jsonValue();

/**
 * @param {{page: Page, options: {skipThirdPartyRequests: true}, basePath: string }} opt
 * @return {Promise<void>}
 */
export const skipThirdPartyRequests = async opt => {
  const { page, options, basePath } = opt;
  if (!options.skipThirdPartyRequests) return;
  await page.setRequestInterception(true);
  page.on("request", request => {
    if (request.url().startsWith(basePath)) {
      request.continue();
    } else {
      request.abort();
    }
  });
};

/**
 * @param {{page: Page, options: {sourceMaps: boolean}, route: string, onError: ?function }} opt
 * @return {void}
 */
export const enableLogging = (opt: IEnableLoggingOptions, logs = []) => {
  const { page, options, basePath, route, onError, sourcemapStore } = opt;
  page.on("console", msg => {

    const text = msg.text();
    if (text === "JSHandle@object") {
      Promise.all(msg.args().map(objectToJson)).then(args => {
        logs.push(args)
        console.log(`💬  console.log of JSHandle@object at ${route}:`, ...args)
      });
    } else if (text === "JSHandle@error") {
      Promise.all(msg.args().map(errorToString)).then(args => {
        logs.push(args)
        console.log(`💬  console.log of JSHandle@error at ${route}:`, ...args)
      });
    } else {
      const url = msg.location().url;
      const ignoreThirdPartyError = options.skipThirdPartyRequests && text.includes("ERR_FAILED") && url && url.includes("http") && !url.includes(options.basePath)

      if (ignoreThirdPartyError) {
          return;
      }

      if (!text.includes("[webpack-dev-server]") && !text.includes("WebSocket")) {
          logs.push([text, url])
          if (!text.includes("was preloaded")) {
            console.log(`️️️💬  console.log at ${route}:`, text, url);
          }
      }
    }
  });
  page.on("error", msg => {
    console.log(`🔥  error at ${route}:`, msg);
    logs.push([msg])
    onError && onError();
  });
  page.on("pageerror", e => {
    if (options.sourceMaps) {
      mapStackTrace(e.stack || e.message, {
        isChromeOrEdge: true,
        store: sourcemapStore || {}
      })
      .then(result => {
          // TODO: refactor mapStackTrace: return array not a string, return first row too
          const stackRows = result.split("\n");
          const puppeteerLine =
          stackRows.findIndex(x => x.includes("puppeteer")) ||
          stackRows.length - 1;

          const msg = `🔥  pageerror at ${route}: ${(e.stack || e.message).split("\n")[0] + "\n"}${stackRows.slice(0, puppeteerLine).join("\n")}`;
          logs.push([msg])
          console.log(msg);
        })
        .catch(e2 => {
          const msg = e;
          logs.push([msg])
          console.log(`🔥  pageerror at ${route}:`, msg);
          console.log(
            `️️️⚠️  warning at ${route} (error in source maps):`,
            e2.message
          );
        });
    } else {
      const msg = e;
      logs.push([msg])
      console.log(`🔥  pageerror at ${route}:`, msg);
    }

    if (e.message !== "Event" && !e.message.startsWith("TypeError")) {
        onError && onError();
    }
  });
  page.on("response", response => {
    if (response.status() >= 400) {
      let route = "";
      try {
        route = response.request()
          .headers()
          .referer.replace(basePath, "");
      } catch (e) {}

      const msg = `️️️⚠️  warning at ${route}: got ${response.status()} HTTP code for ${response.url()}`;
      logs.push([msg])
      console.log(msg);
    }
  });
  // page.on("requestfailed", msg =>
  //   console.log(`️️️⚠️  ${route} requestfailed:`, msg)
  // );
};

/**
 * @param {{page: Page}} opt
 * @return {Promise<Array<string>>}
 */
export const getLinks = async opt => {
  const { page } = opt;
  const anchors = await page.evaluate(() =>
    (Array.from(document.querySelectorAll("a,link[rel='alternate']")) as (HTMLAnchorElement | HTMLLinkElement)[]).map(anchor => {
      if ((anchor.href as any).baseVal) {
        const a = document.createElement("a");
        a.href = (anchor.href as any).baseVal;
        return a.href;
      }
      return anchor.href;
    })
  );

  const iframes = await page.evaluate(() =>
    Array.from(document.querySelectorAll("iframe")).map(iframe => iframe.src)
  );
  return anchors.concat(iframes);
};

/**
 * @typedef UrlLogs
 * @property {string} url True if the token is valid.
 * @property {Array<Array<string>>} logs The user id bound to the token.
 */

/**
 * can not use null as default for function because of TS error https://github.com/Microsoft/TypeScript/issues/14889
 *
 * @param {{options: *, basePath: string, beforeFetch: ?(function({ page: Page, route: string }):Promise), afterFetch: ?(function({ page: Page, browser: Browser, route: string }):Promise), onEnd: ?(function():void)}} opt
 * @return {Promise<Array<UrlLogs>>}
 */
export const crawl = async (opt: ICrawlParams): Promise<IReactSnapRunLogs[]> => {
  const {
    options,
    basePath,
    beforeFetch,
    afterFetch,
    onEnd,
    publicPath,
    sourceDir
  } = opt;
  const exclude = options.exclude;
  let shuttingDown = false;
  let streamClosed = false;

  const onSigint = () => {
    if (shuttingDown) {
      process.exit(1);
    } else {
      shuttingDown = true;
      console.log(
        "\nGracefully shutting down. To exit immediately, press ^C again"
      );
    }
  };
  process.on("SIGINT", onSigint);

  const onUnhandledRejection = error => {
    console.log("🔥  UnhandledPromiseRejectionWarning", error);
    if (!options.ignorePageErrors) {
        shuttingDown = true;
    }
  };
  process.on("unhandledRejection", onUnhandledRejection);

  const queue = _();
  let enqueued = 0;
  let processed = 0;

  const basePathHostname = options.basePath?.replace(/https?:\/\//, "");
  // use Set instead
  const uniqueUrls = new Set();
  const sourcemapStore = {};

  /**
   * @param {string} newUrl
   * @returns {void}
   */
  const addToQueue = (newUrl: string) => {
    const { hostname, search, hash, port, pathname } = url.parse(newUrl);
    newUrl = newUrl.replace(`${search || ""}${hash || ""}`, "");

    // Ensures that only link on the same port are crawled
    //
    // url.parse returns a string,
    // but options port is passed by a user and default value is a number
    // we are converting both to string to be sure
    // Port can be null, therefore we need the null check
    const isOnAppPort = (!port && !options.port) || (port && port.toString() === options.port.toString());

    if (exclude.filter(regex => regex.test(pathname)).length > 0) return;
    if (basePathHostname === hostname && isOnAppPort && !uniqueUrls.has(newUrl) && !streamClosed) {
      uniqueUrls.add(newUrl);
      enqueued++;
      queue.write(newUrl);
      if (enqueued == 2 && options.crawl) {
        addToQueue(`${basePath}${publicPath}/404.html`);
      }
    }
  };

  const browser = await puppeteer.launch({
    headless: options.headless,
    args: options.puppeteerArgs,
    executablePath: options.puppeteerExecutablePath,
    ignoreHTTPSErrors: options.puppeteerIgnoreHTTPSErrors,
    handleSIGINT: false
  });
  /**
   * @param {string} pageUrl
   * @returns {Promise<UrlLogs>}
   */
  const fetchPage = async pageUrl => {
    const route = pageUrl.replace(basePath, "");
    let skipExistingFile = false;
    const routePath = route.replace(/\//g, path.sep);

    const { ext } = path.parse(routePath);
    if (ext !== ".html" && ext !== "") {
      const filePath = path.join(sourceDir, routePath);
      skipExistingFile = fs.existsSync(filePath);
    }

    const logs = [];

    if (!shuttingDown && !skipExistingFile) {
      try {
        const page = await browser.newPage();
        // @ts-ignore
        await page._client.send("ServiceWorker.disable");
        await page.setCacheEnabled(options.puppeteer.cache);
        if (options.viewport) await page.setViewport(options.viewport);
        if (options.skipThirdPartyRequests) await skipThirdPartyRequests({ page, options, basePath });

        enableLogging({
          page,
          options,
          basePath,
          route,
          onError: () => {
            if (!options.ignorePageErrors) {
              shuttingDown = true;
            }
          },
          sourcemapStore
        }, logs);
        beforeFetch && beforeFetch({ page, route });
        await page.setUserAgent(options.userAgent);
        const tracker = createTracker(page);
        let responsePromise: Promise<void | HTTPResponse> = Promise.resolve();
        try {
          await page.goto(pageUrl, { waitUntil: "networkidle2" });

          if (options.waitForResponse) responsePromise = page.waitForResponse(options.waitForResponse, {timeout: 0});

        } catch (e) {
          e.message = augmentTimeoutError(e.message, tracker);
          throw e;
        } finally {
          tracker.dispose();
        }
        await responsePromise;

        if (options.waitFor) await page.waitForTimeout(options.waitFor);
        if (options.crawl) {
          const links = await getLinks({ page });
          links.forEach(addToQueue);
        }
        afterFetch && (await afterFetch({ page, route, browser, addToQueue, logs }));
        await page.close();
        console.log(`✅  crawled ${processed + 1} out of ${enqueued} (${route})`);
      } catch (e) {
        if (!shuttingDown) {
            console.log(`🔥 Crawl error at ${route}`, e);
            if (!options.ignorePageErrors) {
                shuttingDown = true;
            }
        }
      }
    } else {
      // this message creates a lot of noise if crawling enabled
      console.log(`🚧  skipping (${processed + 1}/${enqueued}) ${route}`);
    }
    processed++;
    if (enqueued === processed) {
      streamClosed = true;
      queue.end();
    }
    return {url: pageUrl, logs};
  };

  if (options.include) {
    options.include.map(x => addToQueue(`${basePath}${x}`));
  }


  return new Promise<IReactSnapRunLogs[]>((resolve, reject) => {
    queue
        .map(x => {
            return _(fetchPage(x));
        })
      .mergeWithLimit(options.concurrency)
      .toArray(async (allLogs) => {
        process.removeListener("SIGINT", onSigint);
        process.removeListener("unhandledRejection", onUnhandledRejection);
        await browser.close();
        onEnd && onEnd();
        if (shuttingDown) return reject("");
        resolve(allLogs);
      });
  });
};