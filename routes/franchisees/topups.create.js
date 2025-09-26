// routes/franchisees/topups.create.js
router.post('/franchisees/:franchisee_id/topups', async (req, res) => {
  try {
    const { franchisee_id } = req.params;
    const { variant, drums, litres, source, ref_doc_no, ref_doc_date, notes, idempotency_key } = req.body;

    // validate
    if (!['TPMS', 'HIGHWAY'].includes(variant)) return res.status(400).json({ error: 'invalid_variant' });
    const drumsInt = parseInt(drums, 10);
    if (!Number.isInteger(drumsInt) || drumsInt < 1) return res.status(400).json({ error: 'invalid_drums' });
    const litresCalc = drumsInt * 20;
    if (Number(litres) !== litresCalc) {
      // optional: override client value for safety
    }

    // idempotency check
    const existing = await db.topups.findByIdemKey(idempotency_key);
    if (existing) return res.status(201).json(existing);

    const created = await db.topups.create({
      franchisee_id,
      variant,
      drums: drumsInt,
      litres: litresCalc,
      source,
      ref_doc_no,
      ref_doc_date,
      notes,
      idempotency_key,
      status: 'PENDING'
    });

    return res.status(201).json(created);
  } catch (e) {
    console.error('topup.create', e);
    return res.status(500).json({ error: 'server_error' });
  }
});
