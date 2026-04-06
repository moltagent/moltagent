const Imap = require('imap');

// This will be run with the credential from NC Passwords
async function testImap() {
  const CredentialBroker = require('/opt/moltagent/src/lib/credential-broker');
  
  const broker = new CredentialBroker({
    ncUrl: process.env.NC_URL || 'https://YOUR_NEXTCLOUD_URL',
    ncUsername: process.env.NC_USER || 'moltagent'
  });
  
  const cred = await broker.get('email-imap');
  console.log('Credential host:', cred.host);
  console.log('Credential user:', cred.username || cred.user);
  console.log('Credential port:', cred.port);
  
  const port = parseInt(cred.port) || 993;
  const useStartTls = cred.starttls === true || cred.starttls === 'true' || port === 143;
  
  const imap = new Imap({
    user: cred.username || cred.user,
    password: cred.password,
    host: cred.host,
    port: port,
    tls: !useStartTls,
    autotls: useStartTls ? 'required' : 'never',
    tlsOptions: { rejectUnauthorized: false }
  });
  
  imap.once('ready', () => {
    imap.openBox('INBOX', true, (err, box) => {
      if (err) {
        console.error('Open error:', err);
        imap.end();
        return;
      }
      console.log('Total messages:', box.messages.total);
      console.log('Unread messages:', box.messages.new);
      
      // Search for UNSEEN
      imap.search(['UNSEEN'], (err, results) => {
        console.log('UNSEEN search results:', results ? results.length : 'error', results);
        
        // Also search ALL to compare
        imap.search(['ALL'], (err, all) => {
          console.log('ALL messages:', all ? all.length : 'error');
          imap.end();
        });
      });
    });
  });
  
  imap.once('error', (err) => console.error('IMAP error:', err));
  imap.connect();
}

testImap().catch(console.error);
