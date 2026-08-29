/**
 * Shared helpers for driving the Wheat 2.0 interface from Playwright.
 *
 * Wheat replaced its large native `<select>` elements with a searchable
 * combobox (`WheatSelect`). The value handed to the application is unchanged,
 * but the interaction is now: open the trigger, optionally type into the
 * integrated search bar, then click the matching `role="option"`.
 *
 * `chooseOption` covers both shapes, so a spec can keep expressing intent
 * ("pick this counterparty") without caring which control renders it.
 */

/**
 * Selects a value in either a Wheat combobox or a native `<select>`.
 *
 * @param page Playwright page.
 * @param control Locator for the combobox trigger or the `<select>`.
 * @param option `{ value }`, `{ label }`, `{ index }` or a plain string value.
 */
async function chooseOption(page, control, option) {
  const request = typeof option === "string" ? { value: option } : option;
  const tagName = await control.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");

  if (tagName === "select") {
    if (request.value !== undefined) return control.selectOption(request.value);
    if (request.label !== undefined) return control.selectOption({ label: request.label });
    return control.selectOption({ index: request.index });
  }

  await control.click();
  const listbox = page.locator('[role="listbox"]').last();
  await listbox.waitFor({ state: "visible", timeout: 10000 });

  if (request.value !== undefined) {
    // Every option carries its submitted value, so a spec can target the exact
    // record without depending on the rendered label.
    const byValue = listbox.locator(`[role="option"][data-value="${request.value}"]`);
    if (await byValue.count()) return byValue.first().click();
    // Long lists render a capped window; the search bar brings the rest in.
    const search = page.locator(".wt-select__search input");
    if (await search.count()) {
      await search.fill(String(request.value));
      if (await byValue.count()) return byValue.first().click();
      await search.fill("");
    }
    throw new Error(`No option matching value ${request.value}`);
  }

  if (request.label !== undefined) {
    const search = page.locator(".wt-select__search input");
    if (await search.count()) await search.fill(String(request.label));
    return listbox.locator('[role="option"]').filter({ hasText: request.label }).first().click();
  }

  return listbox.locator('[role="option"]').nth(request.index).click();
}

/** Opens a dossier from the workspace header. */
async function switchCompany(page, companyName) {
  await chooseOption(page, page.locator('.company-switcher [role="combobox"]'), { label: companyName });
}

/** Reads the label currently shown by a Wheat combobox. */
async function selectedLabel(control) {
  return (await control.locator(".wt-select__value").first().innerText()).trim();
}

module.exports = { chooseOption, switchCompany, selectedLabel };
