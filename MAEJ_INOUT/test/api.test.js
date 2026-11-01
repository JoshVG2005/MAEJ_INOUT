const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const mongoose = require("mongoose");
const { after, before, test } = require("node:test");

let serverProcess;
let baseUrl;
let testDatabaseName;
let testMongoUri;

async function availablePort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function graphql(query, variables = {}) {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return { status: response.status, ...(await response.json()) };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 70; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`GraphQL server exited with code ${serverProcess.exitCode}`);
    }
    try {
      const result = await graphql("{ health { status database } }");
      if (result.data?.health?.status === "ok") return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("GraphQL server did not start in time. Check that MongoDB Community is running.");
}

before(async () => {
  const port = await availablePort();
  testDatabaseName = `maej_inout_test_${process.pid}_${Date.now()}`;
  const mongoUrl = new URL(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/maej_inout_test");
  mongoUrl.pathname = `/${testDatabaseName}`;
  testMongoUri = mongoUrl.toString();
  const setupConnection = new mongoose.Mongoose();
  await setupConnection.connect(testMongoUri, { serverSelectionTimeoutMS: 5000 });
  await setupConnection.connection.createCollection("maej_test");
  await setupConnection.disconnect();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [require("node:path").join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      MONGODB_URI: testMongoUri,
      MONGODB_DB: "",
      MONGODB_COLLECTION: "maej_test",
    },
    stdio: "ignore",
  });
  await waitForServer();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill();
    await once(serverProcess, "exit");
  }
  if (testMongoUri) {
    await mongoose.connect(testMongoUri, { serverSelectionTimeoutMS: 5000 });
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test("GraphQL health reports MongoDB as connected", async () => {
  const result = await graphql("{ health { status database } }");
  assert.deepEqual(result.data, { health: { status: "ok", database: "connected" } });
});

test("GraphQL CRUD, equipment-linked expenses and reports work end to end", async () => {
  const incomeResult = await graphql(`
    mutation($input: TransactionInput!) {
      createTransaction(input: $input) { id type }
    }
  `, {
    input: { type: "income", date: "2026-10-10", concept: "Venta de prueba", amount: 1250, method: "Transferencia" },
  });
  assert.equal(incomeResult.errors, undefined);
  const income = incomeResult.data.createTransaction;
  assert.equal(income.type, "income");

  const expenseResult = await graphql(`
    mutation($input: TransactionInput!) {
      createTransaction(input: $input) { id }
    }
  `, {
    input: { type: "expense", date: "2026-10-11", concept: "Servicio de prueba", category: "Servicios", amount: 250, method: "Tarjeta" },
  });
  const expenseId = expenseResult.data.createTransaction.id;
  const updateResult = await graphql(`
    mutation($id: ID!, $input: TransactionInput!) {
      updateTransaction(id: $id, input: $input) { concept }
    }
  `, { id: income.id, input: { concept: "Venta actualizada" } });
  assert.equal(updateResult.data.updateTransaction.concept, "Venta actualizada");

  const equipmentResult = await graphql(`
    mutation($input: EquipmentInput!) {
      createEquipment(input: $input) { id status expenseTransactionId }
    }
  `, {
    input: { name: "Laptop de prueba", type: "Cómputo", date: "2026-10-12", amount: 18000, status: "Planeado" },
  });
  const equipment = equipmentResult.data.createEquipment;
  assert.equal(equipment.expenseTransactionId, null);

  const purchaseResult = await graphql(`
    mutation($id: ID!, $input: EquipmentInput!) {
      updateEquipment(id: $id, input: $input) { expenseTransactionId status }
    }
  `, { id: equipment.id, input: { status: "Comprado", method: "Transferencia" } });
  const expenseTransactionId = purchaseResult.data.updateEquipment.expenseTransactionId;
  assert.ok(expenseTransactionId);
  const expensesAfterPurchase = await graphql(`query { transactions(type: "expense", month: "2026-10") { id type amount equipmentId } }`);
  assert.equal(expensesAfterPurchase.data.transactions.length, 2, JSON.stringify(expensesAfterPurchase));

  const dashboardResult = await graphql(`
    query($month: String!) { dashboard(month: $month) { income expenses profit investmentFund } }
  `, { month: "2026-10" });
  assert.deepEqual(dashboardResult.data.dashboard, { income: 1250, expenses: 18250, profit: -17000, investmentFund: 0 });

  await graphql(`
    mutation($id: ID!, $input: EquipmentInput!) {
      updateEquipment(id: $id, input: $input) { id }
    }
  `, { id: equipment.id, input: { name: "Laptop actualizada", amount: 19000 } });
  const equipmentExpenses = await graphql(`
    query { transactions(type: "expense", month: "2026-10") { id amount equipmentId } }
  `);
  const generated = equipmentExpenses.data.transactions.filter((item) => item.equipmentId === equipment.id);
  assert.equal(generated.length, 1);
  assert.equal(generated[0].amount, 19000);

  const fundResult = await graphql(`
    mutation($input: InvestmentFundInput!) {
      setInvestmentFund(input: $input) { amount }
    }
  `, { input: { month: "2026-10", amount: 32000 } });
  assert.equal(fundResult.data.setInvestmentFund.amount, 32000);
  const summaryResult = await graphql(`query($year: String!) { monthlySummary(year: $year) { month profit investmentFund } }`, { year: "2026" });
  assert.equal(summaryResult.data.monthlySummary.length, 1);
  assert.equal(summaryResult.data.monthlySummary[0].profit, -18000);

  const protectedExpense = await graphql(`mutation($id: ID!) { deleteTransaction(id: $id) }`, { id: expenseTransactionId });
  assert.ok(protectedExpense.errors?.length);
  const deleteEquipment = await graphql(`mutation($id: ID!) { deleteEquipment(id: $id) }`, { id: equipment.id });
  assert.equal(deleteEquipment.data.deleteEquipment, true);
  const remainingLinkedExpense = await graphql(`query { transaction(id: "${expenseTransactionId}") { id } }`);
  assert.ok(remainingLinkedExpense.errors?.length);

  for (const id of [income.id, expenseId]) {
    const result = await graphql(`mutation($id: ID!) { deleteTransaction(id: $id) }`, { id });
    assert.equal(result.data.deleteTransaction, true);
  }
});

test("invalid inputs produce GraphQL errors", async () => {
  const result = await graphql(`
    mutation($input: TransactionInput!) {
      createTransaction(input: $input) { id }
    }
  `, { input: { type: "income", date: "not-a-date", amount: -1 } });
  assert.ok(result.errors?.length);
  assert.match(result.errors[0].message, /tipo|fecha/i);
});

test("frontend is served, REST is removed, and GraphQL data is stored in the chosen collection", async () => {
  const frontend = await fetch(baseUrl);
  assert.equal(frontend.status, 200);
  const oldRestEndpoint = await fetch(`${baseUrl}/api/health`);
  assert.equal(oldRestEndpoint.status, 404);
  const mongo = new mongoose.Mongoose();
  try {
    await mongo.connect(testMongoUri, { serverSelectionTimeoutMS: 5000 });
    const documents = await mongo.connection.collection("maej_test").find({}).toArray();
    assert.ok(documents.every((document) => ["transaction", "equipment", "investmentFund"].includes(document.recordType)));
    assert.ok(documents.some((document) => document.recordType === "investmentFund"));
  } finally {
    await mongo.disconnect();
  }
});
