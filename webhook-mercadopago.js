const crypto = require("crypto");
const admin = require("firebase-admin");

function db() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT não configurada");
    admin.initializeApp({credential: admin.credential.cert(JSON.parse(raw)), projectId: "fretego-e7ca9"});
  }
  return admin.firestore();
}
function signatureOK(req, id) {
  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  const signature = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"];
  if (!secret || !signature || !requestId || !id) return false;
  const p = {};
  for (const part of String(signature).split(",")) {
    const [k, v] = part.trim().split("=");
    if (k && v) p[k] = v;
  }
  if (!p.ts || !p.v1) return false;
  const manifest = `id:${String(id).toLowerCase()};request-id:${requestId};ts:${p.ts};`;
  const expected = crypto.createHmac("sha256", secret).update(manifest).digest();
  const received = Buffer.from(p.v1, "hex");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
const cents = v => Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) : NaN;

async function findCharge(firestore, ext, id) {
  for (const [collection, key] of [
    ["pagamentosComissaoPix", ext],
    ["cobrancasPix", ext],
    ["cobrancasPix", id]
  ]) {
    if (!key) continue;
    const ref = firestore.collection(collection).doc(String(key));
    const snap = await ref.get();
    if (snap.exists) return {ref, data: snap.data(), schema: collection};
  }
  return null;
}

async function settle(firestore, charge, payment) {
  const {ref, data} = charge;
  const paymentId = String(payment.id);
  const driverId = data.motoristaId;
  const ids = data.comissaoIds;
  if (!driverId || !Array.isArray(ids) || !ids.length || new Set(ids.map(String)).size !== ids.length)
    throw new Error("Cobrança sem motorista/comissões válidos");
  if (payment.currency_id !== "BRL" || cents(payment.transaction_amount) !== Number(data.valorCentavos))
    throw new Error("Valor ou moeda não conferem");
  if (charge.schema === "pagamentosComissaoPix") {
    if (String(data.mercadoPagoPaymentId || "") !== paymentId ||
        payment.metadata?.pagamento_tipo !== "comissao_fretego" ||
        String(payment.metadata?.motorista_id || "") !== String(driverId))
      throw new Error("Referências/metadados não conferem");
  } else {
    if (data.pagamentoId && String(data.pagamentoId) !== paymentId)
      throw new Error("ID do pagamento não confere com a cobrança antiga");
    if (payment.metadata?.motorista_id && String(payment.metadata.motorista_id) !== String(driverId))
      throw new Error("Motorista não confere");
  }

  await firestore.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (!current.exists) throw new Error("Cobrança não encontrada na transação");
    const refs = ids.map(id => firestore.collection("comissoes").doc(String(id)));
    const snaps = [];
    for (const r of refs) snaps.push(await tx.get(r));
    for (let i = 0; i < snaps.length; i++) {
      if (!snaps[i].exists) throw new Error(`Comissão ausente: ${ids[i]}`);
      const c = snaps[i].data(), status = String(c.status || "").toLowerCase();
      if (String(c.motoristaId || "") !== String(driverId)) throw new Error("Motorista da comissão não confere");
      const paid = ["pago","paid","approved","aprovado"].includes(status);
      const samePayment = String(c.pagamentoId || c.mercadoPagoPaymentId || "") === paymentId;
      if (!["pendente","pending","pago","paid","approved","aprovado"].includes(status) || (paid && !samePayment))
        throw new Error(`Comissão não pode ser conciliada: ${ids[i]}`);
    }
    refs.forEach((r, i) => {
      const c = snaps[i].data(), status = String(c.status || "").toLowerCase();
      if (!(["pago","paid","approved","aprovado"].includes(status) &&
            String(c.pagamentoId || c.mercadoPagoPaymentId || "") === paymentId)) {
        tx.update(r, {status:"pago", pagamentoId:paymentId, mercadoPagoPaymentId:paymentId,
          pagoEm:admin.firestore.FieldValue.serverTimestamp()});
      }
    });
    tx.update(ref, {status:"approved", mercadoPagoStatus:"approved", mercadoPagoPagamentoId:paymentId,
      pagamentoId:paymentId, aprovadoEm:admin.firestore.FieldValue.serverTimestamp(),
      pagoEm:admin.firestore.FieldValue.serverTimestamp()});
  });
  await firestore.collection("pixComissaoAtivo").doc(String(driverId)).set({
    status:"approved", pagamentoId:paymentId, atualizadoEm:admin.firestore.FieldValue.serverTimestamp()
  }, {merge:true});
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.setHeader("Allow","POST"); return res.status(405).send("Método não permitido"); }
  const id = req.query?.["data.id"] || req.body?.data?.id;
  if (!id) return res.status(400).send("ID do pagamento ausente");
  if (!signatureOK(req, id)) return res.status(401).send("Assinatura inválida");
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) return res.status(500).send("Token do Mercado Pago não configurado");
  try {
    const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`,
      {headers:{Authorization:`Bearer ${token}`}});
    if (!response.ok) {
      console.error("Falha ao consultar pagamento no Mercado Pago", response.status);
      return res.status(503).send("Não foi possível confirmar o pagamento");
    }
    const payment = await response.json();
    if (String(payment.id) !== String(id)) return res.status(503).send("ID do pagamento não confere");
    if (payment.status !== "approved") return res.status(200).send("Pagamento ainda não aprovado");
    const firestore = db();
    const charge = await findCharge(firestore, payment.external_reference, id);
    if (!charge) return res.status(200).send("Cobrança FreteGo não localizada; ignorada");
    await settle(firestore, charge, payment);
    return res.status(200).send("Pagamento e comissões conciliados");
  } catch (e) {
    console.error("Erro no webhook Mercado Pago FreteGo:", e?.message || e);
    return res.status(503).send("Conciliação pendente; será tentada novamente");
  }
};
