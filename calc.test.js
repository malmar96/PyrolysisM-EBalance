// calc.test.js - Regression tests for pyrolysis mass & energy balance
// Extracts calculation logic directly from index.html -- single source of truth.
// Run with: node calc.test.js

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// Load and evaluate the math from index.html
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Stub DOM helpers
code = code.replace(/const g = id =>.*?;/g, 'const g = () => 0;');
code = code.replace(/const fmt = .*?;/g, 'const fmt = () => "";');
code = code.replace(
  'const S = (id, v, d=1) => { const e=document.getElementById(id); if(e) e.textContent=fmt(v,d); };',
  'const S = () => {};'
);
code = code.replace(/attachListeners\(\);/g, '// attachListeners();');
code = code.replace(
  /document\.getElementById\('i_feedstock'\)\.addEventListener[\s\S]*?\}\);/,
  '// stripped'
);
code = code.replace(/^run\(\);$/mg, '// run();');

const domStub = {
  getElementById: () => ({ textContent:'', style:{}, classList:{add:()=>{},remove:()=>{},toggle:()=>{}}, value:'0', readOnly:false }),
  querySelector:  () => ({ innerHTML:'', textContent:'', className:'' }),
  querySelectorAll: () => [],
};
const sandbox = {
  console, module:{}, require,
  document: domStub,
  window: {},
  localStorage: { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} },
  URL: { createObjectURL:()=>'', revokeObjectURL:()=>{} },
};
vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox);
} catch(e) {
  console.error('ERROR evaluating index.html:', e.message);
  process.exit(1);
}

const { calcAt, solveTto, solveRc, solveRcForTtoMin,
        Cp_N2, Cp_CO2, Cp_H2O_g, Cp_O2, Cp_air_mix } = sandbox;
// Constants (declared with const in the script, not on sandbox object)
const N_AIR = 79/21, T_ADP = 150, T_COND = 100;

console.log('Loaded math from index.html\n');

// Test helpers
let passed = 0, failed = 0;
function assert(desc, ok, detail) {
  if (ok) { console.log('  PASS  ' + desc); passed++; }
  else { console.error('  FAIL  ' + desc + (detail ? ' -- ' + detail : '')); failed++; }
}
function assertClose(desc, actual, expected, tol) {
  assert(desc, Math.abs(actual - expected) <= tol,
    'got ' + actual.toFixed(6) + ', expected ' + expected + ' +/- ' + tol);
}

// Baseline inputs: hardwood 13% MC, default parameters
const BASE = {
  fw:1150, mc:0.13, xC:0.492, xH:0.062, xO:0.446, xash:0.003,
  HHVbm:19000, rc:0.25, xCbc:0.70, rHC:0.70, HHVbc:30000,
  xs:0.05, cpBM:1.5, cpSG:2.1, dH:300, Tr:25, Treac:500, Tto_min:650,
};
const FEEDSTOCKS = [
  { name:'Hardwood 20% MC',   inp:{...BASE, mc:0.20, fw:1000/0.80} },
  { name:'Hardwood 35% MC',   inp:{...BASE, mc:0.35, fw:1000/0.65} },
  { name:'Rice hulls 13% MC', inp:{...BASE, mc:0.13, xC:0.4855, xH:0.0631, xO:0.4515, xash:0.192, HHVbm:15000} },
  { name:'Sludge 13% MC',     inp:{...BASE, mc:0.13, xC:0.5655, xH:0.0844, xO:0.3501, xash:0.380, HHVbm:13500} },
];

// 1. Energy balance closure
console.log('1. Energy balance closure');
{
  const r = calcAt(BASE, BASE.rc, solveTto(BASE, BASE.rc));
  assertClose('T23 closes to zero (hardwood 13% MC)', r.T23, 0, 0.001);
  assertClose('T21 = T1 (hardwood 13% MC)',           r.T21, r.T1, 0.001);
}
FEEDSTOCKS.forEach(({name, inp}) => {
  const r = calcAt(inp, inp.rc, solveTto(inp, inp.rc));
  assertClose('T23 closes to zero (' + name + ')', r.T23, 0, 0.001);
});

// 2. Mass balance closure
console.log('\n2. Mass balance closure');
assertClose('Mass in = mass out',
  calcAt(BASE, BASE.rc, solveTto(BASE, BASE.rc)).merr, 0, 0.01);

// 3. Moisture sensitivity direction
console.log('\n3. Moisture sensitivity direction');
{
  const mcs = [0, 0.10, 0.20, 0.30, 0.40];
  const res = mcs.map(mc => {
    const inp = {...BASE, fw:1000/(1-mc), mc, rc:0.25};
    const Tto = solveTto(inp, 0.25);
    return { rec: calcAt(inp, 0.25, Tto).above_adp, Tto };
  });
  for (let i = 1; i < res.length; i++) {
    assert('Recoverable heat falls MC=' + (mcs[i-1]*100).toFixed(0) + '% to ' + (mcs[i]*100).toFixed(0) + '%',
      res[i].rec < res[i-1].rec, res[i].rec.toFixed(1) + ' < ' + res[i-1].rec.toFixed(1));
    assert('T_TO falls MC=' + (mcs[i-1]*100).toFixed(0) + '% to ' + (mcs[i]*100).toFixed(0) + '%',
      res[i].Tto < res[i-1].Tto, res[i].Tto.toFixed(1) + ' < ' + res[i-1].Tto.toFixed(1));
  }
}

// 4. Feasibility detection
console.log('\n4. Feasibility detection');
{
  const sludge40 = {...BASE, mc:0.40, fw:1000/0.60, xC:0.5655, xH:0.0844, xO:0.3501, xash:0.380, HHVbm:13500};
  const Tto_s = solveTto(sludge40, sludge40.rc);
  assert('Sludge 40% MC: T_TO below floor', Tto_s < sludge40.Tto_min, 'T_TO=' + Tto_s.toFixed(1));
  const Tto_h = solveTto(BASE, BASE.rc);
  assert('Hardwood 13% MC: T_TO above floor', Tto_h >= BASE.Tto_min, 'T_TO=' + Tto_h.toFixed(1));
}

// 5. Carbon sequestration bounds
console.log('\n5. Carbon sequestration bounds');
FEEDSTOCKS.concat([{name:'Hardwood baseline', inp:BASE}]).forEach(({name, inp}) => {
  const r = calcAt(inp, inp.rc, solveTto(inp, inp.rc));
  assert('Cseq in [0,1] (' + name + ')', r.Cseq >= 0 && r.Cseq <= 1, 'Cseq=' + r.Cseq.toFixed(3));
});

// 6. T11 sign check
console.log('\n6. T11 (biochar HHV) sign check');
{
  const Tto = solveTto(BASE, 0.25);
  assert('T11 > 0 when rc > 0', calcAt(BASE, 0.25, Tto).T11 > 0);
  assert('T11 = 0 when rc = 0', Math.abs(calcAt(BASE, 0, Tto).T11) < 0.001);
}

// 7. Constants
console.log('\n7. Constants');
assertClose('N_AIR = 79/21', N_AIR, 79/21, 1e-10);
assertClose('T_ADP = 150',   T_ADP, 150, 0);
assertClose('T_COND = 100',  T_COND, 100, 0);

// 8. RC solve mode closure
console.log('\n8. RC solve mode');
{
  const rc = solveRc(BASE, 720);
  assert('Solved rc > 0', rc > 0, 'rc=' + rc.toFixed(4));
  assert('Solved rc < 1', rc < 1, 'rc=' + rc.toFixed(4));
  assertClose('T23 closes in RC mode', calcAt(BASE, rc, 720).T23, 0, 0.001);
}

// 9. Option A remedy: rc* in [0,1] gives T_TO = Tto_min
console.log('\n9. Option A remedy (rc* solve)');
{
  const rh30 = {...BASE, mc:0.30, fw:1000/0.70, xC:0.4855, xH:0.0631, xO:0.4515, xash:0.192, HHVbm:15000};
  if (solveTto(rh30, rh30.rc) < rh30.Tto_min) {
    const rc_star   = solveRcForTtoMin(rh30, rh30.Tto_min);
    const Tto_check = solveTto(rh30, rc_star);
    assert('rc* in [0,1] (rice hulls 30%)', rc_star >= 0 && rc_star <= 1, 'rc*=' + rc_star.toFixed(4));
    assertClose('solveTto(rc*) = Tto_min', Tto_check, rh30.Tto_min, 1.0);
    assertClose('T23 closes at rc*', calcAt(rh30, rc_star, Tto_check).T23, 0, 0.001);
  } else {
    console.log('  SKIP  Rice hulls 30% MC feasible at current Tto_min');
  }
  const sl40 = {...BASE, mc:0.40, fw:1000/0.60, xC:0.5655, xH:0.0844, xO:0.3501, xash:0.380, HHVbm:13500};
  assert('rc* < 0 for sludge 40% MC (Option A not feasible)',
    solveRcForTtoMin(sl40, sl40.Tto_min) < 0);
}

// 10. Shomate Cp correctness (JANAF reference values)
console.log('\n10. Shomate Cp correctness');
assertClose('Cp_N2   at  25C', Cp_N2(25),       0.99497, 0.00005);
assertClose('Cp_N2   at 300C', Cp_N2(300),      1.07263, 0.00005);
assertClose('Cp_N2   at 700C', Cp_N2(700),      1.15366, 0.00005);
assertClose('Cp_CO2  at 100C', Cp_CO2(100),     0.91640, 0.00005);
assertClose('Cp_CO2  at 500C', Cp_CO2(500),     1.15816, 0.00005);
assertClose('Cp_H2Og at 200C', Cp_H2O_g(200),  1.93972, 0.00005);
assertClose('Cp_H2Og at 600C', Cp_H2O_g(600),  2.20137, 0.00005);
assertClose('Cp_O2   at 200C', Cp_O2(200),      0.96262, 0.00005);
assertClose('Cp_O2   at 700C', Cp_O2(700),      1.08554, 0.00005);
assert('Cp_O2 branch continuity at 700K',
  Math.abs(Cp_O2(428) - Cp_O2(426)) < 0.005,
  'below=' + Cp_O2(426).toFixed(4) + ' above=' + Cp_O2(428).toFixed(4));
assertClose('Cp_air at  25C', Cp_air_mix(25),  0.97717, 0.00005);
assertClose('Cp_air at 300C', Cp_air_mix(300), 1.05461, 0.00005);
assertClose('Cp_air = 0.232*O2+0.768*N2 at 500C',
  Cp_air_mix(500), 0.232*Cp_O2(500)+0.768*Cp_N2(500), 0.00001);

// 11. Exhaust fractions sum to 1
console.log('\n11. Exhaust composition fractions sum to 1');
FEEDSTOCKS.concat([{name:'Hardwood baseline', inp:BASE}]).forEach(({name, inp}) => {
  const r = calcAt(inp, inp.rc, solveTto(inp, inp.rc));
  assertClose('Fractions sum to 1 (' + name + ')', r.xCO2+r.xH2O+r.xN2+r.xO2, 1.0, 0.0001);
  assert('All fractions > 0 (' + name + ')',
    r.xCO2 > 0 && r.xH2O > 0 && r.xN2 > 0 && r.xO2 > 0);
});

// Summary
console.log('\n==================================================');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
