pipeline {
    agent any
    stages {
        stage('Build Docker Image') {
            steps {
                // Újraépítjük a Node.js image-et.
                // Fontos: Itt a mappaszerkezet miatt ./app a build context!
                sh 'docker build -t my-node-app:latest ./app'
            }
        }
        stage('Deploy to K8s') {
            steps {
                // Letöltjük a kubectl-t, mert a Jenkins konténerben alapból nincs benne
                sh 'curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"'
                sh 'chmod +x kubectl'
                
                // Frissítjük a Deploymentet. 
                // Mivel a Docker Desktop K8s-t használjuk, a Jenkins (ami szintén Docker)
                // eléri a hostot.
                // A "rollout restart" kényszeríti a podok cseréjét.
                sh './kubectl rollout restart deployment backend-deployment'
            }
        }
    }
}