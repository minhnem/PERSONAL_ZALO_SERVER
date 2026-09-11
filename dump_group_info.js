import { Zalo } from 'zca-js';
import mongoose from 'mongoose';
import { Account } from './src/models/Account.js';

(async () => {
  await mongoose.connect('mongodb://127.0.0.1:27017/autozalo');
  const accountId = 'TK_8965';
  const groupId = '7964238661280840998';
  
  const acc = await Account.findOne({ phoneNumber: accountId });
  const zalo = new Zalo();
  const api = await zalo.login({
      cookie: acc.zcaCredentials.cookie,
      imei: acc.zcaCredentials.imei,
      userAgent: acc.zcaCredentials.userAgent,
  });
  
  const res = await api.getGroupInfo(groupId);
  console.log(JSON.stringify(res.gridInfoMap[groupId], null, 2));
  process.exit(0);
})();
