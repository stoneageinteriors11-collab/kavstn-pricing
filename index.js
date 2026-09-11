/**
 * KAVSTN Secure Pricing + Draft Order API — v4.0.0
 *
 * CONFIGURATION OVERVIEW (v4)
 * ────────────────────────────────────────────────────────────────────────────
 * Shapes:    oval · rectangle · round · square · ellipse
 *
 * Dimensions:
 *   Rectangular (oval / rectangle / ellipse):  140–280 cm length × 90 or 100 cm depth
 *   Circular/Square (round / square):           100–160 cm diameter/side
 *   Below 220 cm = 6 seater · 220 cm and above = 8 seater
 *
 * Top Material:  8 Marble colours + 2 Travertine colours = 10 options
 *
 * Base (auto-assigned — NOT a user choice):
 *   round  → 1 × Block base
 *   others → 1 × Pedestal if length < 220 cm · 2 × Pedestal if length ≥ 220 cm
 *
 * Finish:     Polished · Unpolished
 * Edge:       Bevelled · Straight · Chiselled · Boat
 * Thickness:  3 cm · 4 cm · 5 cm · 6 cm
 *
 * Height:     Universal 76 cm — display only, no metaobject needed.
 *
 * Removed from v3:  base_material · surface_treatment · base_finish
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The browser sends Shopify metaobject IDs only.  This server reads the
 * authoritative values from Shopify, validates relationships, calculates the
 * ex-VAT price, and creates or updates a Draft Order with that verified price.
 *
 * ⚠️  DO NOT push this file to Shopify directly.
 *      Upload it manually to Render (or your Node.js host).
 */

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

const SHOPIFY_API_VERSION = '2026-07';

// ── CORS ─────────────────────────────────────────────────────────────────────

const defaultOrigins = [
  'https://kavstn.co.uk',
  'https://www.kavstn.co.uk',
  'https://kavstn.myshopify.com',
];

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || defaultOrigins.join(','))
    .split(',')
    .map(origin => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin.replace(/\/$/, ''))) {
      return callback(null, true);
    }
    return callback(new Error('Origin is not allowed.'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json({ limit: '32kb' }));

// ── SHOPIFY ADMIN TOKEN (cached, reused for its full lifetime) ────────────────

let cachedAdminToken    = null;
let adminTokenExpiresAt = 0;

async function getShopifyAdminToken() {
  if (cachedAdminToken && Date.now() < adminTokenExpiresAt - 60_000) {
    return cachedAdminToken;
  }

  const shop         = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId     = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    throw new Error(
      'Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET.'
    );
  }

  // IMPORTANT: SHOPIFY_STORE_DOMAIN must be the originating *.myshopify.com
  // domain — not a custom domain alias.  The token endpoint only responds on
  // the .myshopify.com URL.
  const response = await fetch(
    `https://${shop}/admin/oauth/access_token`,
    {
      method:  'POST',
      headers: {
        Accept:         'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     clientId,
        client_secret: clientSecret,
      }),
    }
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Shopify token request failed (${response.status}): ${responseText}`
    );
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Shopify returned a non-JSON token response: ${responseText.slice(0, 300)}`
    );
  }

  if (!data.access_token) {
    throw new Error('Shopify did not return an access token.');
  }

  cachedAdminToken    = data.access_token;
  adminTokenExpiresAt = Date.now() + (Number(data.expires_in) || 86400) * 1000;

  return cachedAdminToken;
}

// ── SHOPIFY GRAPHQL HELPER ────────────────────────────────────────────────────

async function shopifyGraphQL(query, variables = {}) {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;

  if (!shop) throw new Error('Missing SHOPIFY_STORE_DOMAIN.');

  const response = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method:  'POST',
      headers: {
        Accept:                  'application/json',
        'Content-Type':          'application/json',
        'X-Shopify-Access-Token': await getShopifyAdminToken(),
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Shopify Admin API returned ${response.status}: ${responseText}`);
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Shopify returned invalid JSON: ${responseText.slice(0, 300)}`);
  }

  if (data.errors?.length) {
    throw new Error(
      `Shopify GraphQL error: ${data.errors.map(e => e.message).join(', ')}`
    );
  }

  return data.data;
}

// ── SELECTION SCHEMA ──────────────────────────────────────────────────────────
//
// Maps each incoming selection key to the Shopify metaobject type it must
// resolve to.  Seven fields only — base_material, surface_treatment, and
// base_finish have been removed in v4.  The base is auto-determined by shape.
//
// If your Render logs show types prefixed with "custom." (e.g. "custom.table_shape"),
// change the values below to match exactly what Shopify returns.

const selectionSchema = {
  shapeId:          'table_shape',
  dimensionId:      'dimension_preset',
  materialId:       'table_material',
  baseDesignId:     'base_design',
  materialFinishId: 'material_finish',
  edgeProfileId:    'edge_profile',
  thicknessId:      'table_thickness',
};

// ── GRAPHQL QUERY ─────────────────────────────────────────────────────────────

const pricingMetaobjectsQuery = `
  query GetPricingMetaobjects($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Metaobject {
        id
        type
        displayName
        fields {
          key
          value
        }
      }
    }
  }
`;

// ── ERROR CLASS ───────────────────────────────────────────────────────────────

class ClientError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// ── METAOBJECT FIELD HELPERS ──────────────────────────────────────────────────

function assertMetaobjectGid(value, key) {
  const gidPattern = /^gid:\/\/shopify\/Metaobject\/\d+$/;
  if (typeof value !== 'string' || !gidPattern.test(value)) {
    throw new ClientError(`Missing or invalid ${key}.`);
  }
  return value;
}

function field(metaobject, key) {
  const found = metaobject.fields.find(item => item.key === key);
  return found?.value ?? '';
}

function numberField(metaobject, key) {
  const value = Number(field(metaobject, key) || 0);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric field ${metaobject.type}.${key}.`);
  }
  return value;
}

function listValue(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through to comma-separated fallback
  }
  return String(raw).split(',').map(v => v.trim()).filter(Boolean);
}

function referenceIds(metaobject, key) {
  const raw    = field(metaobject, key);
  const parsed = listValue(raw);
  if (parsed.length) {
    return parsed.filter(v => v.startsWith('gid://shopify/'));
  }
  return raw.startsWith('gid://shopify/') ? [raw] : [];
}

function textList(metaobject, key) {
  return listValue(field(metaobject, key)).map(v => v.toLowerCase());
}

function isUnavailable(metaobject) {
  const available = field(metaobject, 'available') || field(metaobject, 'availability');
  return ['false', 'unavailable', 'disabled', 'inactive'].includes(
    String(available).toLowerCase()
  );
}

// requireReference:
//   If the metaobject's `key` field is populated, the referenced ID must
//   match `expectedId`.  If the field is empty, the check is skipped.
function requireReference(metaobject, key, expectedId, label) {
  const references = referenceIds(metaobject, key);
  if (references.length && !references.includes(expectedId)) {
    throw new ClientError(`${label} is not compatible with this configuration.`);
  }
}

// requireTextCompatibility:
//   If the metaobject's `key` field is populated, `expectedValue` must be
//   in the allowed list.  If the field is empty, all values are allowed.
function requireTextCompatibility(metaobject, key, expectedValue, label) {
  const allowed = textList(metaobject, key);
  if (allowed.length && !allowed.includes(String(expectedValue).toLowerCase())) {
    throw new ClientError(`${label} is not compatible with this configuration.`);
  }
}

// ── PRICE + VALIDATION LOGIC ──────────────────────────────────────────────────

async function verifyAndPrice(selections) {
  if (!selections || typeof selections !== 'object') {
    throw new ClientError('Configuration selections are required.');
  }

  const entries = Object.entries(selectionSchema);

  // Validate and collect all GIDs
  const ids = entries.map(([key]) => assertMetaobjectGid(selections[key], key));

  if (new Set(ids).size !== ids.length) {
    throw new ClientError(
      'Each configuration selection must use its own metaobject ID.'
    );
  }

  const data          = await shopifyGraphQL(pricingMetaobjectsQuery, { ids });
  const returnedNodes = (data.nodes || []).filter(Boolean);
  const byId          = new Map(returnedNodes.map(node => [node.id, node]));

  // Resolve each GID to its metaobject, checking that the type matches
  const selected = {};

  entries.forEach(([key, expectedType]) => {
    const metaobject = byId.get(selections[key]);

    if (!metaobject || metaobject.type !== expectedType) {
      // If the type logged here doesn't match the selectionSchema values above,
      // update selectionSchema to use the actual type string Shopify returns.
      throw new ClientError(
        `${key} does not reference a valid ${expectedType} option. ` +
        `(actual type: ${metaobject ? metaobject.type : 'not found'})`
      );
    }

    if (isUnavailable(metaobject)) {
      throw new ClientError(`${metaobject.displayName} is currently unavailable.`);
    }

    selected[key] = metaobject;
  });

  const shape          = selected.shapeId;
  const dimension      = selected.dimensionId;
  const material       = selected.materialId;
  const baseDesign     = selected.baseDesignId;
  const materialFinish = selected.materialFinishId;
  const edge           = selected.edgeProfileId;
  const thickness      = selected.thicknessId;

  // ── Compatibility checks ───────────────────────────────────────────────────
  //
  // Only checks that are still relevant in v4:
  //   • dimension.shape reference must match the selected shape (if field is set)
  //   • materialFinish.material reference must match the selected material (if set)
  //   • edge.compatible_materials must include the material's category (if set)
  //
  // base_material / surface_treatment / base_finish checks removed in v4.

  requireReference(dimension, 'shape', shape.id, 'Dimension');
  requireReference(materialFinish, 'material', material.id, 'Top finish');

  const materialCategory = field(material, 'material_category');
  requireTextCompatibility(edge, 'compatible_materials', materialCategory, 'Edge profile');

  // ── Reject sizes flagged as requiring manual approval ─────────────────────

  if (String(field(dimension, 'requires_approval')).toLowerCase() === 'true') {
    throw new ClientError(
      'This size requires manual approval and cannot be ordered online yet.'
    );
  }

  // ── Dimension measurements (used for display and base count logic) ──────────
  //
  // Fields store values in mm directly.
  // These are NOT used for area-based pricing — all prices are flat.

  const shapeHandle = field(shape, 'shape_handle').toLowerCase();

  const lengthMm   = numberField(dimension, 'width_mm');    // the longer side (rectangular)
  const widthMm    = numberField(dimension, 'depth_mm');    // the shorter side (rectangular)
  const diameterMm = numberField(dimension, 'diameter_mm'); // round / square

  // Validate that the preset has usable measurements for display purposes
  if (diameterMm === 0 && (lengthMm === 0 || widthMm === 0)) {
    throw new ClientError(
      'The selected dimension preset has incomplete measurements.'
    );
  }

  // ── Price calculation (all flat additions — no area multiplication) ─────────
  //
  // Formula:
  //   total = shape.base_price
  //         + material.price_per_sqm  (treated as a flat material price)
  //         + material.base_price     (optional extra flat base; usually 0)
  //         + dimension.price_adj
  //         + baseDesign.price_adj
  //         + materialFinish.price_adj
  //         + edge.price_adj
  //         + thickness.price_adj

  const adjustments = {
    dimension:      numberField(dimension,      'price_adj'),
    baseDesign:     numberField(baseDesign,     'price_adj'),
    materialFinish: numberField(materialFinish, 'price_adj'),
    edge:           numberField(edge,           'price_adj'),
    thickness:      numberField(thickness,      'price_adj'),
  };

  const totalAdjustments  = Object.values(adjustments).reduce((sum, v) => sum + v, 0);
  const shapeBasePrice    = numberField(shape,    'base_price');
  const materialBasePrice = numberField(material, 'base_price');
  const materialFlatPrice = numberField(material, 'price_per_sqm'); // flat price, not per-sqm

  const verifiedPrice =
    shapeBasePrice + materialBasePrice + materialFlatPrice + totalAdjustments;

  if (!Number.isFinite(verifiedPrice) || verifiedPrice <= 0) {
    throw new Error(
      'The authoritative Shopify pricing data produced an invalid price.'
    );
  }

  // ── Derive base count from shape and table length ──────────────────────────
  //
  //   round  → always 1 × Block
  //   others → 1 × Pedestal if length < 220 cm · 2 × Pedestals if length ≥ 220 cm

  let baseDescription = baseDesign.displayName;
  if (shapeHandle === 'round') {
    baseDescription = '1 × ' + baseDesign.displayName;
  } else {
    // lengthMm already read above — 2 pedestals if table is 220 cm (2200 mm) or longer
    const baseCount = lengthMm >= 2200 ? 2 : 1;
    baseDescription = baseCount + ' × ' + baseDesign.displayName;
  }

  // ── Dimension display string ───────────────────────────────────────────────

  const dimensionDisplay = diameterMm > 0
    ? `Diameter ${diameterMm / 10} cm`
    : `${lengthMm / 10} × ${widthMm / 10} cm`;

  // ── Line-item properties (stored on the Draft Order line item) ─────────────
  //
  // These are the customer-facing and internal order details shown in Shopify admin.
  // All keys are plain text — no underscore prefix — so they display cleanly.

  const properties = {
    'Shape':                    shape.displayName,
    'Dimensions':               field(dimension, 'label') || dimensionDisplay,
    'Seating':                  field(dimension, 'seats') || '—',
    'Top Material':             material.displayName,
    'Base':                     baseDescription,
    'Top Finish':               materialFinish.displayName,
    'Edge Profile':             edge.displayName,
    'Thickness':                field(thickness, 'label') || `${field(thickness, 'thickness_mm')} mm`,
    'Verified Price':           `£${verifiedPrice.toFixed(2)}`,
  };

  return {
    price:      Math.round(verifiedPrice * 100) / 100,
    properties,
  };
}

// ── DRAFT ORDER GRAPHQL ───────────────────────────────────────────────────────

const getDraftOrderQuery = `
  query GetDraftOrder($id: ID!) {
    draftOrder(id: $id) {
      id
      status
      lineItems(first: 50) {
        nodes {
          title
          originalUnitPrice
          quantity
          customAttributes { key value }
        }
      }
    }
  }
`;

const createDraftOrderMutation = `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id invoiceUrl }
      userErrors   { field message }
    }
  }
`;

const updateDraftOrderMutation = `
  mutation DraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder { id invoiceUrl }
      userErrors   { field message }
    }
  }
`;

function mutationPayload(payload, operationName) {
  const errors = payload?.userErrors || [];
  if (errors.length) {
    throw new ClientError(errors.map(e => e.message).join(', '));
  }
  if (!payload?.draftOrder) {
    throw new Error(`Shopify did not return a draft order from ${operationName}.`);
  }
  return payload.draftOrder;
}

// ── DRAFT ORDER TOKEN (HMAC-signed, stored in sessionStorage on the client) ───

function signingSecret() {
  const secret = process.env.DRAFT_ORDER_SIGNING_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'DRAFT_ORDER_SIGNING_SECRET must contain at least 32 characters.'
    );
  }
  return secret;
}

function signDraftOrderId(draftOrderId) {
  const signature = crypto
    .createHmac('sha256', signingSecret())
    .update(draftOrderId)
    .digest('base64url');

  const encodedId = Buffer.from(draftOrderId).toString('base64url');
  return `${encodedId}.${signature}`;
}

function verifyDraftOrderToken(token) {
  if (!token) return null;

  if (typeof token !== 'string' || token.length > 500 || !token.includes('.')) {
    throw new ClientError('Invalid draft order token.');
  }

  const [encodedId, suppliedSignature] = token.split('.');
  const draftOrderId = Buffer.from(encodedId, 'base64url').toString('utf8');

  const draftOrderPattern = /^gid:\/\/shopify\/DraftOrder\/\d+$/;
  if (!draftOrderPattern.test(draftOrderId)) {
    throw new ClientError('Invalid draft order token.');
  }

  const expectedSignature = crypto
    .createHmac('sha256', signingSecret())
    .update(draftOrderId)
    .digest('base64url');

  const supplied = Buffer.from(suppliedSignature || '');
  const expected = Buffer.from(expectedSignature);

  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  ) {
    throw new ClientError('Invalid draft order token.');
  }

  return draftOrderId;
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  return res.json({
    service: 'KAVSTN Secure Pricing API',
    version: '4.0.0',
    status:  'running',
  });
});

// GET /auth/status — confirms the server can authenticate with Shopify
app.get('/auth/status', async (req, res) => {
  try {
    await getShopifyAdminToken();
    return res.json({
      authenticated: true,
      method:        'client_credentials',
      token_cached:  Boolean(cachedAdminToken),
      expires_at:    new Date(adminTokenExpiresAt).toISOString(),
    });
  } catch (error) {
    return res.status(500).json({ authenticated: false, error: error.message });
  }
});

// GET /health — used by Render and uptime monitors
app.get('/health', (req, res) => {
  return res.json({ ok: true });
});

// POST /price — validate selections + return verified price (no Draft Order)
app.post('/price', async (req, res) => {
  try {
    const verified = await verifyAndPrice(req.body.selections);
    return res.json({ success: true, price: verified.price });
  } catch (error) {
    console.error('[KAVSTN] /price error:', error.message);
    return res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// POST /set-price — deprecated in v3, kept as a tombstone
app.post('/set-price', (req, res) => {
  return res.status(410).json({
    error: 'This endpoint is disabled. Use /add-to-order.',
  });
});

// POST /add-to-order — validate + price + create/update a Shopify Draft Order
//
// WHY DRAFT ORDERS?
// ─────────────────
// A single Shopify variant has one shared price.  If three tables are added
// at £2,000 / £3,500 / £4,800, each /set-price call overwrites the last, so
// all three show £4,800 at checkout.  Draft Orders solve this: each line item
// carries its own locked price, so ordering multiple tables always works correctly.
//
// HOW IT WORKS:
//   1. First table → POST with draftOrderToken: null → server creates a new Draft Order.
//   2. Server returns a signed draftOrderToken.  The browser saves this in sessionStorage.
//   3. Second table → POST with the stored token → server appends a new line item.
//   4. Customer clicks the invoiceUrl to pay through Shopify's standard checkout.
//   5. Closing the tab (sessionStorage scope) always starts a fresh order.

app.post('/add-to-order', async (req, res) => {
  try {
    signingSecret();  // fail fast if not configured

    const verified              = await verifyAndPrice(req.body.selections);
    const requestedDraftOrderId = verifyDraftOrderToken(req.body.draftOrderToken);

    const newLineItem = {
      title:              'KAVSTN Bespoke Dining Table',
      originalUnitPrice:  verified.price.toFixed(2),
      quantity:           1,
      customAttributes:   Object.entries(verified.properties).map(([key, value]) => ({
        key,
        value: String(value),
      })),
    };

    let draftOrderId = null;
    let lineItems    = [newLineItem];

    // If a valid draft order token was supplied, append to the existing order
    if (requestedDraftOrderId) {
      const existingData = await shopifyGraphQL(getDraftOrderQuery, {
        id: requestedDraftOrderId,
      });

      const existing = existingData.draftOrder;

      if (existing?.status === 'OPEN') {
        draftOrderId = existing.id;

        const existingItems = (existing.lineItems?.nodes || []).map(node => ({
          title:             node.title,
          originalUnitPrice: node.originalUnitPrice,
          quantity:          node.quantity,
          customAttributes:  node.customAttributes,
        }));

        lineItems = [...existingItems, newLineItem];
      }
    }

    let draftOrder;

    if (draftOrderId) {
      const data = await shopifyGraphQL(updateDraftOrderMutation, {
        id:    draftOrderId,
        input: { lineItems },
      });
      draftOrder = mutationPayload(data.draftOrderUpdate, 'draftOrderUpdate');
    } else {
      const data = await shopifyGraphQL(createDraftOrderMutation, {
        input: { lineItems },
      });
      draftOrder = mutationPayload(data.draftOrderCreate, 'draftOrderCreate');
    }

    return res.json({
      success:        true,
      draftOrderId:   draftOrder.id,
      draftOrderToken: signDraftOrderId(draftOrder.id),
      invoiceUrl:     draftOrder.invoiceUrl,
      verifiedPrice:  verified.price,
    });

  } catch (error) {
    console.error('[KAVSTN] /add-to-order error:', error.message);
    return res
      .status(error.status || 500)
      .json({ success: false, error: error.message });
  }
});

// ── ERROR HANDLER ─────────────────────────────────────────────────────────────

app.use((error, req, res, next) => {
  if (error.message === 'Origin is not allowed.') {
    return res.status(403).json({ success: false, error: error.message });
  }
  return next(error);
});

// GET /overlays — returns ALL base_material_overlay entries using the Admin API.
// Bypasses Liquid's hard 50-entry limit so every material × base combination
// (currently 79 entries) is available to the configurator's preview renderer.
app.get('/overlays', async (req, res) => {
  try {
    const entries = [];
    let cursor    = null;
    let hasMore   = true;

    while (hasMore) {
      const data = await shopifyGraphQL(`
        query GetBaseOverlays($cursor: String) {
          metaobjects(type: "base_material_overlay", first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              fields {
                key
                value
                reference {
                  ... on MediaImage {
                    image { url(transform: { maxWidth: 1200 }) }
                  }
                }
              }
            }
          }
        }
      `, { cursor });

      const page = data.metaobjects;
      page.nodes.forEach(node => {
        let materialHandle = '';
        let baseHandle     = '';
        const entry        = {};

        node.fields.forEach(field => {
          if (field.key === 'material_handle') {
            materialHandle = field.value || '';
          } else if (field.key === 'base_handle') {
            baseHandle = field.value || '';
          } else if (field.key.startsWith('overlay_')) {
            const shapeKey = field.key.replace('overlay_', '');
            entry[shapeKey] = (field.reference && field.reference.image)
              ? field.reference.image.url
              : '';
          }
        });

        if (materialHandle && baseHandle) {
          entry.key = materialHandle + '_' + baseHandle;
          entries.push(entry);
        }
      });

      hasMore = page.pageInfo.hasNextPage;
      cursor  = page.pageInfo.endCursor;
    }

    return res.json({ success: true, entries });
  } catch (error) {
    console.error('[KAVSTN] /overlays error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`KAVSTN Secure Pricing API v4.0.0 running on port ${PORT}`);
});