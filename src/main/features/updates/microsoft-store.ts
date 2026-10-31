/**
 * The app's Microsoft Store listing. A Store install is updated by the Store,
 * so the app sends the user to its page there instead of updating itself.
 */

/** NexusCode's Store product ID in Partner Center. */
export const STORE_PRODUCT_ID = "9P04CSF0J5ZD";

/** Opens the product page in the Store app, which offers a pending update. */
export const STORE_PAGE_URL = `ms-windows-store://pdp/?productid=${STORE_PRODUCT_ID}`;
