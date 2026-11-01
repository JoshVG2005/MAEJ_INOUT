require("dotenv").config();

const express = require("express");
const { createHandler } = require("graphql-http/lib/use/express");
const { buildSchema } = require("graphql");
const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const path = require("node:path");

const app = express();
const port = Number(process.env.PORT) || 3000;
const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/maej_inout_test";
const collectionName = process.env.MONGODB_COLLECTION || "maej_test";

const generatedExpenseSchema = new mongoose.Schema({
  id: { type: String, required: true },
  type: { type: String, required: true, default: "expense", enum: ["expense"] },
  date: { type: String, required: true },
  concept: { type: String, required: true },
  category: { type: String, required: true },
  amount: { type: Number, required: true },
  method: { type: String, required: true },
  notes: { type: String, required: true },
}, { _id: false });

const recordSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  recordType: { type: String, required: true, enum: ["transaction", "equipment", "investmentFund"] },
  companyId: { type: String, required: true, default: "default" },
  type: { type: String, enum: ["income", "expense"] },
  date: String,
  concept: String,
  category: { type: String, default: "" },
  amount: Number,
  method: { type: String, default: "" },
  notes: { type: String, default: "" },
  name: String,
  equipmentType: String,
  supplier: { type: String, default: "" },
  status: { type: String, enum: ["Planeado", "Comprado", "En uso", "En mantenimiento"] },
  expenseTransactionId: { type: String, default: null },
  generatedExpense: { type: generatedExpenseSchema, default: undefined },
  month: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, {
  collection: collectionName,
  versionKey: false,
  strict: true,
});

recordSchema.index(
  { recordType: 1, companyId: 1, date: -1 },
  { name: "records_company_date_idx" },
);
recordSchema.index(
  { companyId: 1, month: 1 },
  { unique: true, partialFilterExpression: { recordType: "investmentFund" }, name: "fund_company_month_unique_idx" },
);

const Record = mongoose.model("Record", recordSchema, collectionName);

function validationError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function isValidDate(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function isValidMonth(value) {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function validateText(value, field, { required = false, max = 240 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw validationError(`El campo '${field}' es obligatorio.`);
    return "";
  }
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw validationError(`El campo '${field}' debe ser texto${required ? " no vacío" : ""} de máximo ${max} caracteres.`);
  }
  return value.trim();
}

function validateAmount(value, { allowZero = false } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || (allowZero ? amount < 0 : amount <= 0)) {
    throw validationError(`La cantidad debe ser un número ${allowZero ? "mayor o igual a cero" : "mayor que cero"}.`);
  }
  return amount;
}

function validateTransaction(body, existing = {}) {
  const type = body.type ?? existing.type;
  if (!["income", "expense"].includes(type)) {
    throw validationError("El tipo debe ser 'income' o 'expense'.");
  }
  const date = body.date ?? existing.date;
  if (!isValidDate(date)) {
    throw validationError("La fecha debe tener formato válido YYYY-MM-DD.");
  }
  const categoryValue = body.category ?? existing.category ?? "";
  return {
    type,
    date,
    concept: validateText(body.concept ?? existing.concept, "concept", { required: true, max: 80 }),
    category: type === "expense" ? validateText(categoryValue, "category", { required: true, max: 60 }) : "",
    amount: validateAmount(body.amount ?? existing.amount),
    method: validateText(body.method ?? existing.method, "method", { required: true, max: 40 }),
    notes: validateText(body.notes ?? existing.notes ?? "", "notes", { max: 240 }),
  };
}

function validateEquipment(body, existing = {}) {
  const date = body.date ?? existing.date;
  if (!isValidDate(date)) {
    throw validationError("La fecha debe tener formato válido YYYY-MM-DD.");
  }
  const status = body.status ?? existing.status;
  const validStatuses = ["Planeado", "Comprado", "En uso", "En mantenimiento"];
  if (!validStatuses.includes(status)) {
    throw validationError(`El estado debe ser uno de: ${validStatuses.join(", ")}.`);
  }
  const equipment = {
    name: validateText(body.name ?? existing.name, "name", { required: true, max: 80 }),
    type: validateText(body.type ?? existing.type, "type", { required: true, max: 60 }),
    date,
    amount: validateAmount(body.amount ?? existing.amount, { allowZero: true }),
    supplier: validateText(body.supplier ?? existing.supplier ?? "", "supplier", { max: 80 }),
    method: validateText(body.method ?? existing.method ?? "", "method", { max: 40 }),
    status,
  };
  if (status !== "Planeado" && equipment.amount <= 0) {
    throw validationError("Un equipo comprado debe tener un precio mayor que cero para registrarse como gasto.");
  }
  return equipment;
}

function toTransaction(record) {
  return {
    id: record.id || String(record._id),
    type: record.type,
    date: record.date,
    concept: record.concept,
    category: record.category || "",
    amount: record.amount,
    method: record.method || "",
    notes: record.notes || "",
    equipmentId: record.equipmentId || null,
  };
}

function toEquipment(record) {
  return {
    id: String(record._id),
    name: record.name,
    type: record.equipmentType,
    date: record.date,
    amount: record.amount,
    supplier: record.supplier || "",
    method: record.method || "",
    status: record.status,
    expenseTransactionId: record.expenseTransactionId || null,
  };
}

async function findEquipment(id) {
  const record = await Record.findOne({ _id: id, companyId: "default", recordType: "equipment" }).lean();
  if (!record) throw Object.assign(new Error("Equipo no encontrado."), { status: 404 });
  return record;
}

async function findTransaction(id) {
  const transaction = await Record.findOne({ _id: id, companyId: "default", recordType: "transaction" }).lean();
  if (transaction) return toTransaction(transaction);
  const equipment = await Record.findOne({
    companyId: "default",
    recordType: "equipment",
    expenseTransactionId: id,
  }).lean();
  if (equipment?.generatedExpense) {
    return toTransaction({ ...equipment.generatedExpense, id, equipmentId: String(equipment._id) });
  }
  throw Object.assign(new Error("Movimiento no encontrado."), { status: 404 });
}

function equipmentExpense(equipment, equipmentId, expenseId) {
  return {
    id: expenseId,
    type: "expense",
    date: equipment.date,
    concept: `Equipo: ${equipment.name}`.slice(0, 80),
    category: "Equipo",
    amount: equipment.amount,
    method: equipment.method || "Otro",
    notes: `Gasto generado automáticamente al registrar el equipo ${equipmentId}.`,
  };
}

async function listTransactions({ type, month } = {}) {
  if (type !== undefined && !["income", "expense"].includes(type)) {
    throw validationError("El filtro type debe ser 'income' o 'expense'.");
  }
  if (month !== undefined && !isValidMonth(month)) {
    throw validationError("El filtro month debe tener formato YYYY-MM.");
  }
  const [records, equipmentRecords] = await Promise.all([
    Record.find({ companyId: "default", recordType: "transaction", ...(type ? { type } : {}) }).lean(),
    type === "income"
      ? Promise.resolve([])
      : Record.find({ companyId: "default", recordType: "equipment", expenseTransactionId: { $ne: null } }).lean(),
  ]);
  const transactions = records.map(toTransaction);
  for (const equipment of equipmentRecords) {
    if (equipment.generatedExpense) {
      transactions.push(toTransaction({
        ...equipment.generatedExpense,
        id: equipment.expenseTransactionId,
        equipmentId: String(equipment._id),
      }));
    }
  }
  return transactions
    .filter((transaction) => !type || transaction.type === type)
    .filter((transaction) => !month || transaction.date.slice(0, 7) === month)
    .sort((left, right) => right.date.localeCompare(left.date) || right.id.localeCompare(left.id));
}

async function listFunds(month) {
  if (month !== undefined && !isValidMonth(month)) {
    throw validationError("El filtro month debe tener formato YYYY-MM.");
  }
  return Record.find({
    companyId: "default",
    recordType: "investmentFund",
    ...(month ? { month } : {}),
  }).sort({ month: 1 }).select({ _id: 0, month: 1, amount: 1 }).lean();
}

async function latestFundForMonth(month) {
  const fund = await Record.findOne({
    companyId: "default",
    recordType: "investmentFund",
    month: { $lte: month },
  }).sort({ month: -1 }).lean();
  return fund?.amount ?? 0;
}

const schema = buildSchema(`
  type Health { status: String!, database: String! }
  type Transaction { id: ID!, type: String!, date: String!, concept: String!, category: String!, amount: Float!, method: String!, notes: String!, equipmentId: ID }
  type Equipment { id: ID!, name: String!, type: String!, date: String!, amount: Float!, supplier: String!, method: String!, status: String!, expenseTransactionId: ID }
  type InvestmentFund { month: String!, amount: Float! }
  type Dashboard { month: String!, income: Float!, expenses: Float!, profit: Float!, investmentFund: Float! }
  type MonthlySummary { month: String!, income: Float!, expenses: Float!, investmentFund: Float!, profit: Float! }
  input TransactionInput { type: String, date: String, concept: String, category: String, amount: Float, method: String, notes: String }
  input EquipmentInput { name: String, type: String, date: String, amount: Float, supplier: String, method: String, status: String }
  input InvestmentFundInput { month: String!, amount: Float! }
  type Query {
    health: Health!
    transactions(type: String, month: String): [Transaction!]!
    transaction(id: ID!): Transaction!
    equipment: [Equipment!]!
    investmentFund(month: String): [InvestmentFund!]!
    dashboard(month: String): Dashboard!
    monthlySummary(year: String): [MonthlySummary!]!
  }
  type Mutation {
    createTransaction(input: TransactionInput!): Transaction!
    updateTransaction(id: ID!, input: TransactionInput!): Transaction!
    deleteTransaction(id: ID!): Boolean!
    createEquipment(input: EquipmentInput!): Equipment!
    updateEquipment(id: ID!, input: EquipmentInput!): Equipment!
    deleteEquipment(id: ID!): Boolean!
    setInvestmentFund(input: InvestmentFundInput!): InvestmentFund!
  }
`);

const root = {
  health: () => ({
    status: "ok",
    database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  }),
  transactions: listTransactions,
  transaction: ({ id }) => findTransaction(id),
  equipment: async () => {
    const records = await Record.find({ companyId: "default", recordType: "equipment" }).sort({ date: -1 }).lean();
    return records.map(toEquipment);
  },
  investmentFund: ({ month }) => listFunds(month),
  dashboard: async ({ month } = {}) => {
    const selectedMonth = month || new Date().toISOString().slice(0, 7);
    if (!isValidMonth(selectedMonth)) throw validationError("El mes debe tener formato YYYY-MM.");
    const transactions = await listTransactions({ month: selectedMonth });
    const income = transactions
      .filter((transaction) => transaction.type === "income")
      .reduce((sum, transaction) => sum + transaction.amount, 0);
    const expenses = transactions
      .filter((transaction) => transaction.type === "expense")
      .reduce((sum, transaction) => sum + transaction.amount, 0);
    return {
      month: selectedMonth,
      income,
      expenses,
      profit: income - expenses,
      investmentFund: await latestFundForMonth(selectedMonth),
    };
  },
  monthlySummary: async ({ year } = {}) => {
    const selectedYear = year || String(new Date().getFullYear());
    if (!/^\d{4}$/.test(selectedYear)) throw validationError("El año debe tener cuatro dígitos.");
    const [transactions, funds] = await Promise.all([listTransactions(), listFunds()]);
    const months = new Set([
      ...transactions.filter((entry) => entry.date.startsWith(`${selectedYear}-`)).map((entry) => entry.date.slice(0, 7)),
      ...funds.filter((entry) => entry.month.startsWith(`${selectedYear}-`)).map((entry) => entry.month),
    ]);
    const result = [];
    for (const month of [...months].sort((a, b) => b.localeCompare(a))) {
      const monthTransactions = transactions.filter((entry) => entry.date.startsWith(`${month}-`));
      const income = monthTransactions
        .filter((entry) => entry.type === "income")
        .reduce((sum, entry) => sum + entry.amount, 0);
      const expenses = monthTransactions
        .filter((entry) => entry.type === "expense")
        .reduce((sum, entry) => sum + entry.amount, 0);
      const fund = funds.find((entry) => entry.month === month);
      result.push({
        month,
        income,
        expenses,
        investmentFund: fund?.amount ?? await latestFundForMonth(month),
        profit: income - expenses,
      });
    }
    return result;
  },
  createTransaction: async ({ input }) => {
    const transaction = validateTransaction(input);
    const id = randomUUID();
    await Record.create({
      _id: id,
      recordType: "transaction",
      companyId: "default",
      ...transaction,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { id, ...transaction };
  },
  updateTransaction: async ({ id, input }) => {
    const existing = await Record.findOne({ _id: id, companyId: "default", recordType: "transaction" }).lean();
    if (!existing) {
      const linkedEquipment = await Record.exists({ companyId: "default", recordType: "equipment", expenseTransactionId: id });
      if (linkedEquipment) throw validationError("Este gasto se sincroniza con un equipo; edítalo desde la sección Equipos.");
      throw Object.assign(new Error("Movimiento no encontrado."), { status: 404 });
    }
    const transaction = validateTransaction(input, existing);
    await Record.updateOne(
      { _id: id, companyId: "default", recordType: "transaction" },
      { $set: { ...transaction, updatedAt: new Date() } },
    );
    return { id, ...transaction };
  },
  deleteTransaction: async ({ id }) => {
    const linkedEquipment = await Record.exists({ companyId: "default", recordType: "equipment", expenseTransactionId: id });
    if (linkedEquipment) throw validationError("Este gasto se genera desde un equipo; elimina el equipo para quitar ambos registros.");
    const result = await Record.deleteOne({ _id: id, companyId: "default", recordType: "transaction" });
    if (!result.deletedCount) throw Object.assign(new Error("Movimiento no encontrado."), { status: 404 });
    return true;
  },
  createEquipment: async ({ input }) => {
    const equipment = validateEquipment(input);
    const id = randomUUID();
    const expenseTransactionId = equipment.status === "Planeado" ? null : randomUUID();
    const record = await Record.create({
      _id: id,
      recordType: "equipment",
      companyId: "default",
      name: equipment.name,
      equipmentType: equipment.type,
      date: equipment.date,
      amount: equipment.amount,
      supplier: equipment.supplier,
      method: equipment.method,
      status: equipment.status,
      expenseTransactionId,
      generatedExpense: expenseTransactionId ? equipmentExpense(equipment, id, expenseTransactionId) : undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return toEquipment(record.toObject());
  },
  updateEquipment: async ({ id, input }) => {
    const current = await findEquipment(id);
    const equipment = validateEquipment(input, {
      name: current.name,
      type: current.equipmentType,
      date: current.date,
      amount: current.amount,
      supplier: current.supplier,
      method: current.method,
      status: current.status,
    });
    if (current.expenseTransactionId && equipment.status === "Planeado") {
      throw validationError("Un equipo que ya generó un gasto no puede volver al estado Planeado.");
    }
    const expenseTransactionId = current.expenseTransactionId || (equipment.status === "Planeado" ? null : randomUUID());
    const updated = await Record.findOneAndUpdate(
      { _id: id, companyId: "default", recordType: "equipment" },
      {
        $set: {
          name: equipment.name,
          equipmentType: equipment.type,
          date: equipment.date,
          amount: equipment.amount,
          supplier: equipment.supplier,
          method: equipment.method,
          status: equipment.status,
          expenseTransactionId,
          generatedExpense: expenseTransactionId ? equipmentExpense(equipment, id, expenseTransactionId) : undefined,
          updatedAt: new Date(),
        },
      },
      { new: true, runValidators: true },
    ).lean();
    if (!updated) throw Object.assign(new Error("Equipo no encontrado."), { status: 404 });
    return toEquipment(updated);
  },
  deleteEquipment: async ({ id }) => {
    const result = await Record.deleteOne({ _id: id, companyId: "default", recordType: "equipment" });
    if (!result.deletedCount) throw Object.assign(new Error("Equipo no encontrado."), { status: 404 });
    return true;
  },
  setInvestmentFund: async ({ input }) => {
    const { month } = input;
    if (!isValidMonth(month)) throw validationError("El mes debe tener formato YYYY-MM.");
    const amount = validateAmount(input.amount, { allowZero: true });
    await Record.updateOne(
      { companyId: "default", recordType: "investmentFund", month },
      {
        $set: { amount, updatedAt: new Date() },
        $setOnInsert: { _id: randomUUID(), companyId: "default", recordType: "investmentFund", month },
      },
      { upsert: true, runValidators: true },
    );
    return { month, amount };
  },
};

app.use(express.json({ limit: "100kb" }));
app.all("/graphql", createHandler({ schema, rootValue: root }));
app.get("/", (_request, response) => response.sendFile(path.join(__dirname, "index.html")));
app.get("/app.js", (_request, response) => response.sendFile(path.join(__dirname, "app.js")));
app.get("/styles.css", (_request, response) => response.sendFile(path.join(__dirname, "styles.css")));
app.get("/favicon.ico", (_request, response) => response.status(204).end());
app.use((_request, response) => response.status(404).json({ error: "Ruta no encontrada." }));
app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status || 500).json({
    error: error.status ? error.message : "Error interno del servidor.",
  });
});

async function start() {
  await mongoose.connect(mongoUri, {
    dbName: process.env.MONGODB_DB || undefined,
    serverSelectionTimeoutMS: 5000,
  });
  await Record.createCollection();
  await Record.createIndexes();
  const server = app.listen(port, () => {
    const actualPort = server.address().port;
    console.log(`MAEJ INOUT disponible en http://localhost:${actualPort}`);
    console.log(`GraphQL disponible en http://localhost:${actualPort}/graphql`);
    console.log(`MongoDB conectado: ${mongoose.connection.name}.${collectionName}`);
  });
  const close = async () => {
    server.close();
    await mongoose.disconnect();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

start().catch((error) => {
  console.error("No se pudo iniciar MAEJ INOUT con MongoDB.", error);
  process.exitCode = 1;
});
