type TmbPayload = Record<string, unknown>;

const UTMIFY_ENDPOINT =
  "https://api.utmify.com.br/api-credentials/orders";

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cents(value: unknown): number {
  return Math.round(number(value) * 100);
}

function normalizeStatus(value: unknown): string {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function cleanPhone(value: unknown): string | null {
  const phone = text(value).replace(/\D/g, "");
  return phone || null;
}

function utcDate(value: unknown): string | null {
  const original = text(value);

  if (!original) {
    return null;
  }

  // A TMB normalmente envia horário de Brasília sem fuso explícito.
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(original);
  const date = new Date(hasTimezone ? original : `${original}-03:00`);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 19).replace("T", " ");
}

function paymentMethod(payload: TmbPayload): "pix" | "boleto" {
  const description = [
    payload.provedor_negociado,
    payload.titulo,
    payload.code,
  ]
    .map(text)
    .join(" ")
    .toLowerCase();

  return description.includes("pix") ? "pix" : "boleto";
}

export async function GET() {
  return Response.json({
    status: "online",
    integration: "TMB -> UTMify",
  });
}

export async function POST(request: Request) {
  try {
    const utmifyToken = process.env.UTMIFY_API_TOKEN;
    const webhookSecret = process.env.TMB_WEBHOOK_SECRET;

    if (!utmifyToken || !webhookSecret) {
      console.error("Variáveis de ambiente ausentes.");

      return Response.json(
        { error: "Server configuration error" },
        { status: 500 },
      );
    }

    const receivedSecret = request.headers.get("x-webhook-secret");

    if (receivedSecret !== webhookSecret) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = (await request.json()) as TmbPayload;
    const tmbStatus = normalizeStatus(payload.status_pedido);

    let status: "paid" | "refunded";

    if (tmbStatus === "efetivado") {
      status = "paid";
    } else if (tmbStatus === "cancelado") {
      status = "refunded";
    } else {
      // Confirma o recebimento de eventos que não precisam ir para a UTMify.
      return Response.json({
        received: true,
        ignored: true,
        status: tmbStatus,
      });
    }

    const orderId = text(payload.pedido || payload.id);
    const productId = text(payload.lancamento_id);
    const productName =
      text(payload.lancamento) || text(payload.titulo) || "Produto TMB";
    const customerName = text(payload.cliente);
    const customerEmail = text(payload.email);

    if (!orderId || !productId || !customerName || !customerEmail) {
      console.error("Payload obrigatório incompleto", {
        orderId,
        productId,
        hasCustomerName: Boolean(customerName),
        hasCustomerEmail: Boolean(customerEmail),
      });

      return Response.json(
        { error: "Invalid TMB payload" },
        { status: 400 },
      );
    }

    const grossValue =
      cents(payload.valor_principal) || cents(payload.valor_total);

    if (grossValue <= 0) {
      return Response.json(
        { error: "Invalid transaction value" },
        { status: 400 },
      );
    }

    const createdAt =
      utcDate(payload.criado_em) ||
      new Date().toISOString().slice(0, 19).replace("T", " ");

    const approvedDate =
      utcDate(payload.data_efetivado) ||
      (status === "paid" ? createdAt : null);

    const refundedAt =
      status === "refunded"
        ? new Date().toISOString().slice(0, 19).replace("T", " ")
        : null;

    const utmifyPayload = {
      orderId,
      platform: "TMB",
      paymentMethod: paymentMethod(payload),
      status,
      createdAt,
      approvedDate,
      refundedAt,

      customer: {
        name: customerName,
        email: customerEmail,
        phone: cleanPhone(
          payload.telefone_ativo || payload.telefones,
        ),
        document: text(payload.documento) || null,
        country: text(payload.endereco_pais) || "BR",
      },

      products: [
        {
          id: productId,
          name: productName,
          planId: text(payload.code) || null,
          planName: text(payload.titulo) || null,
          quantity: 1,
          priceInCents: grossValue,
        },
      ],

      trackingParameters: {
        src: null,
        sck: null,
        utm_source:
          text(payload.utm_last_source) ||
          text(payload.utm_source) ||
          null,
        utm_campaign:
          text(payload.utm_last_campaign) ||
          text(payload.utm_campaign) ||
          null,
        utm_medium:
          text(payload.utm_last_medium) ||
          text(payload.utm_medium) ||
          null,
        utm_content:
          text(payload.utm_last_content) ||
          text(payload.utm_content) ||
          null,
        utm_term: null,
      },

      commission: {
        totalPriceInCents: grossValue,
        gatewayFeeInCents: 0,
        userCommissionInCents: grossValue,
        currency: "BRL",
      },
    };

    const utmifyResponse = await fetch(UTMIFY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": utmifyToken,
      },
      body: JSON.stringify(utmifyPayload),
      cache: "no-store",
    });

    const responseBody = await utmifyResponse.text();

    if (!utmifyResponse.ok) {
      console.error("Erro retornado pela UTMify", {
        orderId,
        status: utmifyResponse.status,
        response: responseBody,
      });

      return Response.json(
        {
          error: "UTMify rejected the order",
          details: responseBody,
        },
        { status: 502 },
      );
    }

    console.log("Venda enviada para a UTMify", {
      orderId,
      status,
    });

    return Response.json({
      success: true,
      orderId,
      status,
    });
  } catch (error) {
    console.error("Erro no webhook TMB", error);

    return Response.json(
      { error: "Internal webhook error" },
      { status: 500 },
    );
  }
}
