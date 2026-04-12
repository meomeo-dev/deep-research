import fs from "node:fs";
import path from "node:path";

export interface FakeCrawl4aiPackageInput {
  errorMessage: string;
}

export const createFakeCrawl4aiPackage = (
  fixtureRoot: string,
  input: FakeCrawl4aiPackageInput
): string => {
  const packageRoot = path.join(fixtureRoot, "fake-crawl4ai");
  const moduleRoot = path.join(packageRoot, "crawl4ai");
  const processorsRoot = path.join(moduleRoot, "processors");
  fs.mkdirSync(processorsRoot, { recursive: true });

  fs.writeFileSync(
    path.join(moduleRoot, "__init__.py"),
    [
      "from types import SimpleNamespace",
      `ERROR_MESSAGE = ${JSON.stringify(input.errorMessage)}`,
      "",
      "class CrawlerRunConfig:",
      "    def __init__(self, **kwargs):",
      "        self.__dict__.update(kwargs)",
      "",
      "class BrowserConfig:",
      "    def __init__(self, **kwargs):",
      "        self.__dict__.update(kwargs)",
      "",
      "class UndetectedAdapter:",
      "    pass",
      "",
      "class AsyncWebCrawler:",
      "    def __init__(self, crawler_strategy=None, config=None):",
      "        self.crawler_strategy = crawler_strategy",
      "        self.config = config",
      "",
      "    async def __aenter__(self):",
      "        return self",
      "",
      "    async def __aexit__(self, exc_type, exc, tb):",
      "        return False",
      "",
      "    async def arun(self, url, config=None):",
      "        return SimpleNamespace(success=False, error_message=ERROR_MESSAGE, url=url)"
    ].join("\n"),
    "utf8"
  );

  fs.writeFileSync(
    path.join(moduleRoot, "async_crawler_strategy.py"),
    [
      "class AsyncPlaywrightCrawlerStrategy:",
      "    def __init__(self, browser_config=None, browser_adapter=None):",
      "        self.browser_config = browser_config",
      "        self.browser_adapter = browser_adapter"
    ].join("\n"),
    "utf8"
  );

  fs.writeFileSync(path.join(processorsRoot, "__init__.py"), "", "utf8");
  fs.writeFileSync(
    path.join(processorsRoot, "pdf.py"),
    [
      "class PDFContentScrapingStrategy:",
      "    pass",
      "",
      "class PDFCrawlerStrategy:",
      "    pass"
    ].join("\n"),
    "utf8"
  );

  return packageRoot;
};
