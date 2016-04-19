"use strict";

var google = require ('googleapis');
var fs = require('fs');
//var readline = require('readline');
var readlineSync = require('readline-sync');

const readline = require('readline');



var depthpipe = 4;
var outpipe = "logstats.txt";
var titleLine = "\nchannelId , channelName , channelType , views , views_log , views_log_round , likes , ratio , duration , duration_min , comments , age , avg_ratio , min_ratio , max_ratio";


var re_depth = /--depth=(\d+)/i;
var re_out = /--output=([A-Za-z0-9_\.\-]+)/i;

var youtube_api_key = null;
var youtube = null;

var channel_ids = ['UCXIYLgIp6DYZHjmUUUXErmg'];
var channel_types = []

var dataPoints = [];
const TIME_CATS = [60,50,40,30,20,15,10,8,6,5,4,3,2,1,0];
var time_table = [];
var views_table = [];

//quota limitation variables
const MAX_DAILY = 50000000;
const MAX_100S = 300000;
const MAX_20S  = Math.min(MAX_100S/100, MAX_DAILY/(24*3600))*20;
var quota_20s = 0;
var quota_total = 0;
var start_time = 0;
var last_20s_check = 0;

//read arguments
process.argv.forEach(function(val) {
    var depthParam = val.match(re_depth);
    if(depthParam !== null){
        //console.log("type of param depth : "+ (typeof depthParam[1]));
        depthpipe = depthParam[1];
    }
    var outParam = val.match(re_out);
    if(outParam !== null){
        //console.log("type of param out : "+ (typeof outParam[1]));
        outpipe = outParam[1];


    }
    else if (val == "--help") {
        console.log("Proper Usage: node main.js");
        console.log("    --depth=n           Sets max depth of exploration per channel");
        console.log("    --output=filename   use file 'filename' for output");
        console.log("    --help              Help menu");
        console.log("");
        process.exit(0);
    }
});


var openFiles = function(){

    var criticalError = function(err){
        console.error("ERR : " + err);
        process.exit(1);
    };

    var outOpenProm = function(resolve, reject){
        fs.stat(outpipe,(err, stats) => {
            if(err){
                if(err.code == 'ENOENT') {
                    console.log("output file doesn't exists, will be created");
                } else {
                    console.log("output file doesn't exists or something else happened : ", err.code);
                }
                fs.writeFile(outpipe,titleLine,"utf8", (err) => {
                    if (err) {
                        reject("could not write title line to file.");
                    }else{
                        resolve();
                    }
                });
            }else{
                console.log("output file exists");

                let rl = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout
                });

                rl.question('Do you want to overwrite(o)?append(a)? ', (answer) => {
                    if (answer == "o") {
                        fs.writeFile(outpipe,titleLine,"utf8", (err) => {
                            if (err) {
                                reject("could not write title line to file.");
                            }else{
                                resolve();
                            }
                        });
                    }else{
                        resolve();
                    }
                rl.close();
                });
            }
        });
    };

    var apiKeyOpenProm = function(resolve, reject){
        fs.readFile('yt_api_key.txt','utf8', (err,api_key_file) => {
            if(err){
                if (err.code === 'ENOENT') {
                    reject('Key file not found!');
                }else{
                    reject("unknown error opening api key file.");
                }

            }else{
                let key_regexp = /[A-Za-z0-9\-]{30,}/;
                let api_key = key_regexp.exec(api_key_file);
                if (api_key === null) {
                    reject("google API key not found in provided file");
                }else{
                    resolve(api_key[0]);
                    
                }
            }
        });
    };

    var openChannelListProm = function(resolve, reject){
        fs.readFile('yt_ids.txt',"utf8",(err, data) => {
            if (err) {
                reject(err);
            }else{
                let channels = data.split("\n");
                while (channels[channels.length - 1] === "" || channels[channels.length - 1] == " ") {
                    channels.pop();
                }
                let re = /[A-Za-z0-9_-]{24}/;
                let reType = /type:([A-Z]{1,4})/;
                let filteredChannels = [];
                let filteredTypes = [];
                for (let i = 0; i < channels.length; i++) {
                    let keyTmp = re.exec(channels[i]);
                    if (keyTmp !== null) {
                        let index = filteredChannels.push(keyTmp[0]) - 1;
                        let typeTmp = reType.exec(channels[i]);
                        if (typeTmp !== null) {
                            if (typeTmp[1]!==undefined) {
                                filteredTypes[index] = typeTmp[1];
                            }
                        }
                    }

                }
                console.log(filteredChannels.length+" channels loaded");
                channel_ids = filteredChannels;
                channel_types = filteredTypes;
                resolve();
            }
        });
    }

    var outOpen = new Promise(outOpenProm)
    .then(() => {
        console.log("Success opening output file.");

        var apiKeyOpen = new Promise(apiKeyOpenProm)
        .then((api_key) => {
            youtube_api_key = api_key;
            console.log("Success opening API key file.");

            var channelListOpen = new Promise(openChannelListProm)
            .then(API_init)
            .catch((err) => { 
                console.error("non-critical error reading channel list :\n"+err);
                API_init();
            });
        })
        .catch(criticalError);

    })
    .catch(criticalError);

};

var API_init = function(){
    google.options ({ auth: youtube_api_key });
    youtube = google.youtube ('v3');
    console.log("API initialised");

    //start searching
    start_time = Date.now();
    chainSearch({depth: depthpipe, channelIds: channel_ids, postAction:like_view_analyzer});

};



var quota_update = function(increm){
    quota_20s+=increm;
    quota_total+=increm;
};
var quota_check = function(){
    var now = Date.now();
    var exec_time = (now-start_time)/1000;
    if (exec_time == 0) {
        return true;
    }
    if ((now-last_20s_check)/1000 > 20) {
        console.log("testing 20s quota");

        last_20s_check = now;
        var tmpQuota = quota_20s;
        console.log("quota 20s : "+tmpQuota+"/"+MAX_20S);
        quota_20s = 0;
        if (tmpQuota > MAX_20S) {
            return false;
        }
    }
    if (quota_total/exec_time*20 > MAX_20S) {
        return false;
    }
    return true;
};

// Search Youtube -- callback is called on each found item
function search_youtube (query, callback) {

    var queryObject = {
        part: 'snippet',
        type: 'video',
        maxResults: 4,
        order: 'date',
        safeSearch: 'none'
    };
    if (query.q !== undefined) {
        queryObject.q = query.q;
    }
    if (query.pageToken !== undefined) {
        queryObject.pageToken = query.pageToken;
    }
    if (query.maxResults !==undefined) {
        queryObject.maxResults = query.maxResults;
    }if (query.channel !== undefined) {
        queryObject.channelId = query.channel;
    }
    var channelType = null;
    if (query.channelType !== undefined) {
        channelType = query.channelType;
    }
    var videos = [];
    var detailsLoop = function(res, index, errors, outfunction){
        //console.log(res);
        if (index >= res.length) {
            if (errors === '') {
                outfunction(null, videos);
            }else{
                outfunction(errors, videos);
            }
  
        }else{
            var video = {
                id: res[index].id.videoId,
                title: res[index].snippet.title || '',
                channelTitle: res[index].snippet.channelTitle,
                channelId: res[index].snippet.channelId,
                channelType: channelType,
                timeSincePublished: Math.floor((Date.now() - Date.parse(res[index].snippet.publishedAt))/1000)
            };
            console.log("Qt: "+quota_total+" fetching details for video "+ index + "("+video.title+")");
  
            if (quota_check() === false) {
                setTimeout(function(){console.log("temporisation");detailsLoop(res,index,errors,outfunction);},1000);
            }else{
                quota_update(1+2+2);
                youtube.videos.list (
                {
                    part: 'statistics, contentDetails',
                    id: video.id
                },
                function (err2, data) {
                    if (err2) { detailsLoop(res, index+1, errors+"\n"+err2, outfunction); }
                    if (data.items.length >= 1) {
                        data.items[0].contentDetails.duration.replace (/PT(\d+)M(\d+)S/, 
                            function (t, m, s) {
                                video.duration = (parseInt (m) *60) + parseInt (s);
                        });
                        video.definition = data.items[0].contentDetails.definition;
                        video.views = parseInt(data.items[0].statistics.viewCount);
                        video.likes = parseInt(data.items[0].statistics.likeCount);
                        video.dislikes = parseInt(data.items[0].statistics.dislikeCount);
                        video.comments = parseInt(data.items[0].statistics.commentCount);
                        videos.push(video);
  
                        detailsLoop(res, index+1, errors, outfunction);
                    }
                  }
                );
            }
  
        }
  
    };
    if (quota_check() === false) {
        setTimeout(function(){
            console.log("temporisation");
            search_youtube(query, callback);
        },1000);
    }else{
        quota_update(100);
        youtube.search.list (
            queryObject,
            function (err, res) {
                if (err) { return callback (err); }
  
                detailsLoop(res.items, 0,'', callback);
  
            }
        );
    }
}

var like_view_analyzer = function(err, vid_list, callback){
    if (err !== null) {
        console.error(err);
        return;
    }

    var stats = {
        min_ratio : 10000,
        max_ratio : 0,
        avg_ratio : null,
        cumulViews : 0,
        cumulLikes : 0
    };
    console.log("like/view analyzer start");


    var statsLoop = function(videos, stats, callback){
        let vid = videos.shift();
        let ratio = vid.likes/vid.views;
        if (ratio < stats.min_ratio) {
            stats.min_ratio = ratio;
        }
        if (ratio> stats.max_ratio) {
            stats.max_ratio = ratio;
        }
        stats.cumulLikes+=vid.likes;
        stats.cumulViews+=vid.views;
        let viewsLog = Math.log2(vid.views);
        //console.log(ratio + "\n" + "views : " + videos[i].views);
        var statsPoint = {
            channelId:vid.channelId,
            channelName:vid.channelTitle,
            channelType:vid.channelType,
            views: vid.views,
            viewsLog: viewsLog,
            viewsLogRounded: Math.round(viewsLog),
            likes: vid.likes,
            ratio: ratio,
            duration: vid.duration,
            durationMin: Math.round(vid.duration/60),
            comments: vid.comments,
            age: vid.timeSincePublished
        };
        dataPoints.push(statsPoint);
        fs.appendFile(outpipe,"\n"+
        statsPoint.channelId+" , "+
        statsPoint.channelName+" , "+
        (statsPoint.channelType===null?"":statsPoint.channelType)+" , "+
        statsPoint.views+" , "+
        statsPoint.viewsLog+" , "+
        statsPoint.viewsLogRounded+" , "+
        statsPoint.likes+" , "+
        statsPoint.ratio+" , "+
        statsPoint.duration+" , "+
        statsPoint.durationMin+" , "+
        statsPoint.comments+" , "+
        statsPoint.age,
         'utf8',
        () => {
            if (videos.length > 0) {
                statsLoop(videos, stats, callback);
            }else{
                statsCherry(stats, callback);
            }
        });
    };

    var statsCherry = function(stats, callback){
        stats.avg_ratio = stats.cumulLikes/stats.cumulViews;
        console.log(stats);
        fs.appendFile(outpipe, 
            " , "+stats.avg_ratio+" , "+stats.min_ratio+" , "+stats.max_ratio,
            'utf8',
            callback);
    };


    if (vid_list.length>0) {
        statsLoop(vid_list, stats, callback);
    }else{
        callback();
    }

};

var dataAnalysis = function(){
    console.log("Data Analysis Started.");
    //console.log(dataPoints);
    for (let i = dataPoints.length - 1; i >= 0; i--) {

        //average likes per views levels
        if (views_table[dataPoints[i].viewsLogRounded] == undefined) {
            views_table[dataPoints[i].viewsLogRounded] = {i:1, likes_moy:dataPoints[i].likes, ratio_moy:dataPoints[i].ratio};
        }else{
            views_table[dataPoints[i].viewsLogRounded].likes_moy = (views_table[dataPoints[i].viewsLogRounded].likes_moy * views_table[dataPoints[i].viewsLogRounded].i + dataPoints[i].likes)/(views_table[dataPoints[i].viewsLogRounded].i+1);
            views_table[dataPoints[i].viewsLogRounded].ratio_moy = (views_table[dataPoints[i].viewsLogRounded].ratio_moy * views_table[dataPoints[i].viewsLogRounded].i + dataPoints[i].ratio)/(views_table[dataPoints[i].viewsLogRounded].i+1);
            views_table[dataPoints[i].viewsLogRounded].i+=1;
        }
        let j=0;
        while(dataPoints[i].durationMin<TIME_CATS[j]){
            j++;
        }
        //average ratio per content duration levels
        if (time_table[j] == undefined) {
            time_table[j] = {cat:TIME_CATS[j], i:1, ratio_moy:dataPoints[i].ratio, variance:0, e_type:0, disp:0};
        }else{
            let new_moy = (time_table[j].ratio_moy * time_table[j].i + dataPoints[i].ratio)/(time_table[j].i+1);
            let new_var = time_table[j].variance + Math.pow(time_table[j].ratio_moy - new_moy, 2) + Math.pow(dataPoints[i].ratio - new_moy, 2)/time_table[j].i;
            time_table[j].ratio_moy = new_moy;
            time_table[j].variance = new_var;
            time_table[j].e_type = Math.sqrt(new_var);
            time_table[j].disp = time_table[j].e_type/Math.sqrt(time_table[j].i+1);
            time_table[j].i+=1;
        }
    }

    // console.log("dataPoints");
    // console.log(dataPoints);
    // console.log("time_table");
    // console.log(time_table);
    // console.log("views_table");
    // console.log(views_table);
    var dataDigest = "\n\nViews Table :\nViews log , nb items , likes avg , ratio avg";
    views_table.forEach((item, index) => {
        dataDigest += "\n"+index+" , "+item.i+" , "+item.likes_moy+" , "+item.ratio_moy;
    });
    dataDigest+="\n\n Duration Table :\nDuration , nb items , ratio avg , variance , ecart type , dispertion"
    time_table.forEach((item, index) => {
        dataDigest += "\n"+item.cat+" , "+item.i+" , "+item.ratio_moy+" , "+item.variance+" , "+item.e_type+" , "+item.disp;
    });

    fs.appendFile(outpipe,dataDigest,'utf8',() => {console.log("Data Analysis Is Done ans writtent to file.");})
};

//search sequence
// start_time = Date.now();
//search_youtube({channel:'UCXIYLgIp6DYZHjmUUUXErmg', maxResults: 50},like_view_analyzer);

var defaultPost = function(err, videos, callback){
    if (err) {
        console.error(err);
    }
    if (videos) {
        console.log("loaded "+videos.length+" videos.");
    }
    callback();
};
var chainSearch = function(params){
    var options = {};
    options.depth = params.depth || 4;
    options.channelIds = params.channelIds || ['UCXIYLgIp6DYZHjmUUUXErmg'];
    options.postAction = params.postAction || defaultPost;
    var calendar = [];


    var scheduler = function(index){
        if (index == -1) {//init calendar
            console.log("initialising scheduling jobs...");
            for (var i = 0; i < options.channelIds.length; i++) {
                console.log("defining schedule for channel "+options.channelIds[i]);

                calendar.push((j) => {
                    console.log("executing Task "+j+" on channel " + options.channelIds[j]);
                    search_youtube(
                        {channel:options.channelIds[j], 
                        maxResults: options.depth,
                        channelType:channel_types[j]},
                        (err, videos) => {
                        options.postAction(err, videos, () => {
                            scheduler(j+1);
                        });
                    });
                });

            }
            console.log("... Done.");
            scheduler(0);
        }else if(index < calendar.length){

            calendar[index](index);
        }else if (index >= calendar.length) {
            console.log("No job left. Exiting scheduler.");
            dataAnalysis();
        }
    };

    scheduler(-1);
};

openFiles();
