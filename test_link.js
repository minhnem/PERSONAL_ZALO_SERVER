import { initZaloApi, extractCredentialsFromPlaywright } from './src/scripts/zalo-api.worker.js';
import mongoose from 'mongoose';
import { Account } from './src/models/Account.js';

async function testLink() {
  await mongoose.connect('mongodb://127.0.0.1:27017/autozalo');
  const account = await Account.findOne({ zcaStatus: 'connected' }) || await Account.findOne({});
  
  if (!account) {
    console.log("No account found");
    process.exit(1);
  }

  try {
    let credentials = account.zcaCredentials;
    if (!credentials || !credentials.cookie) {
      console.log("Extracting credentials...");
      credentials = await extractCredentialsFromPlaywright(account.phoneNumber);
      account.zcaCredentials = credentials;
      await account.save();
    }

    const api = await initZaloApi(account.phoneNumber, credentials);
    const link = 'https://zalo.me/g/kettcn256';
    
    console.log(`Testing getGroupLinkInfo for ${link}`);
    const res = await api.getGroupLinkInfo({ link, memberPage: 1 });
    
    console.log(`totalMember reported: ${res.totalMember}`);
    console.log(`currentMems count page 1: ${res.currentMems?.length}`);
    console.log(`hasMoreMember: ${res.hasMoreMember}`);
    
    if (res.hasMoreMember) {
        const res2 = await api.getGroupLinkInfo({ link, memberPage: 2 });
        console.log(`currentMems count page 2: ${res2.currentMems?.length}`);
    }

  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

testLink();
