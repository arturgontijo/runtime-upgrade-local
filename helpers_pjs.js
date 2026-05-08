// Steps to upgrade parachain runtime
// ---- Relay ----
// 1 - Give Alice Sudo access
// 2 - Fund Alice account
// 3 - Call paras.authorizeForceSetCurrentCodeHash(para, newCodeHash, 10_000) [sudo]
// 4 - Call paras.applyAuthorizedForceSetCurrentCode(para, newCode) [sudo]
// 5 - Advance 10 blocks and check events
// ---- Parachain ----
// 6 - Run JS snippet to authorize upgrade "Parachain: Authorize upgrade"
// 7 - Advance 10 blocks and check events

// ------------------------------ Sudo ------------------------------
// Developer → JavaScript, on RELAY endpoint
const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
await api.rpc('dev_setStorage', { Sudo: { Key: ALICE } });

// ------------------------------ Fund account ------------------------------
// Huge balance (adjust decimals/magnitude for your chain’s UNIT)
const FREE = 10_000n * 10n ** 18n;

await api.rpc('dev_setStorage', {
  System: {
    Account: [
      [
        [ALICE],
        {
          providers: 1,
          consumers: 0,
          sufficients: 0,
          data: {
            free: FREE,
            reserved: 0,
            frozen: 0,
            flags: 0
          }
        }
      ]
    ]
  }
});

// optional: rebuild one block from Chopsticks UI / churn script
await api.rpc('dev_newBlock', { count: 1 });

// ------------------------------ Parachain: Authorize upgrade ------------------------------
const inner = api.registry.createType('FrameSystemCodeUpgradeAuthorization', {
  codeHash: '0xcd06061f471978e0c22bec2e6b345a6110024684dabf2e5b128ba2a6cd74495b',
  checkVersion: false,
});
const opt = api.registry.createType('Option<FrameSystemCodeUpgradeAuthorization>', inner);
const encodedHex = opt.toHex();

await api.rpc('dev_setStorage', {
  System: {
    AuthorizedUpgrade: encodedHex,
  },
});

const after = await api.query.system.authorizedUpgrade();
console.log('system.authorizedUpgrade:', JSON.stringify(after.toHuman()));
await api.rpc('dev_newBlock', { count: 1 });
// ----------------------------------------------------------------------------------------------
