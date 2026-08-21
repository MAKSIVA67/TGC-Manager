const fs=require("fs"), path=require("path");
const puppeteer=require("../node_modules/puppeteer-core");
const {portrait}=require("./svg.js");
const CHROME="C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const DIR=__dirname;

const cards=fs.readFileSync(path.join(DIR,"cards.tsv"),"utf8").trim().split("\n").map(l=>{
  const [file,id,name,position,rarity]=l.split("\t");
  return {file:+file, id:+id, name, position, rarity};
});

(async()=>{
  const b=await puppeteer.launch({executablePath:CHROME,headless:"new",args:["--no-sandbox"]});
  const page=await b.newPage();
  await page.setViewport({width:842,height:1191,deviceScaleFactor:1});
  let n=0;
  for(const c of cards){
    const svg=portrait(c);
    await page.setContent(`<html><body style="margin:0">${svg}</body></html>`,{waitUntil:"load"});
    await page.screenshot({path:path.join(DIR,"out",c.file+".png")});
    n++;
    if(n%20===0) console.log("  rendered "+n+"/"+cards.length);
  }
  // A contact sheet so the whole set can be judged at once.
  const sheet=cards.filter((_,i)=>i%3===0).slice(0,24).map(c=>`<div style="width:150px"><div style="aspect-ratio:842/1191;background:#000">${portrait(c)}</div></div>`).join("");
  await page.setViewport({width:960,height:1000});
  await page.setContent(`<html><body style="margin:0;background:#0b1220;display:flex;flex-wrap:wrap;gap:8px;padding:8px">
    <style>svg{width:100%;height:auto;display:block}</style>${sheet}</body></html>`,{waitUntil:"load"});
  await page.screenshot({path:path.join(DIR,"contact-sheet.png"),fullPage:true});
  await b.close();
  console.log("done: "+n+" portraits + contact sheet");
})().catch(e=>{console.error("FAIL "+e.message);process.exit(1);});
